/**
 * An engine that drives an external agent process instead of running its own loop — for example a vendor command-line
 * agent the user has already signed in to with their subscription. The login belongs to that program; this adapter never
 * sees or stores a token. It speaks the navvied protocol to the front-end and the agent's JSON-line stream to the process.
 */
import { LineSplitter, RecentIds, type Command, type Effort, type EngineEvent, type ModelInfo, type PermMode, type PromptCommand } from "@navvied/protocol";
import type { AgentEngine } from "@navvied/engine";
import { buildArgv } from "./argv.ts";
import { Translator } from "./translate.ts";

/** The id of the choice that leaves the model to the program itself: no model flag is given. */
export const DEFAULT_MODEL = "default";

export interface StreamEngineOptions {
  command: string;
  args?: string[];
  model?: string;
  /** The models a person can switch to; `id` is what the program is given after its model flag. */
  models?: ModelInfo[];
  /** The effort levels the program accepts; none when it has no such setting. */
  efforts?: Effort[];
  cwd: string;
  window: number;
  emit: (event: EngineEvent) => void;
  sessionId?: string;
  persona?: string;
  /** A command the program runs before each of its tools. */
  guard?: string;
  env?: Record<string, string>;
  /** How long to wait for the agent to stop after a cancel before killing it (ms, default 5000). */
  cancelGraceMs?: number;
  heartbeatMs?: number;
}

type Child = ReturnType<typeof Bun.spawn>;

const imageBlock = (i: NonNullable<PromptCommand["images"]>[number]) => ({ type: "image", source: { type: "base64", media_type: i.mime, data: i.data } });

export class StreamEngine implements AgentEngine {
  #sessionId: string;
  readonly #o: StreamEngineOptions;
  readonly #tr: Translator;
  #child: Child | undefined;
  /** The program was started and has not said anything yet. */
  #starting = false;
  #running: { mode: PermMode; effort: Effort | undefined; model: string | undefined } | undefined;
  #model: string | undefined;
  #mode: PermMode = "auto";
  #effort: Effort | undefined;
  #busy = false;
  readonly #qids = new RecentIds();
  /** uuids of messages written to the agent whose echo (`taken`) has not come back yet */
  #pending = new Set<string>();
  #prompts = new Map<string, { qid: string; text: string; images: number }>();
  #waiters: (() => void)[] = [];
  #stderr = "";
  #killTimer: ReturnType<typeof setTimeout> | undefined;
  #heartbeat: ReturnType<typeof setInterval> | undefined;
  #closed = false;

  constructor(opts: StreamEngineOptions) {
    this.#o = opts;
    this.#sessionId = opts.sessionId ?? "";
    this.#model = opts.model;
    this.#tr = new Translator({ window: opts.window, onTaken: (uuid) => {
      this.#pending.delete(uuid);
      const p = this.#prompts.get(uuid);
      if (!p) return;
      this.#prompts.delete(uuid);
      this.#emit({ ev: "user", qid: p.qid, text: p.text, ...(p.images ? { images: p.images } : {}) });
    } });
    const every = opts.heartbeatMs ?? 15_000;
    if (every > 0) { this.#heartbeat = setInterval(() => { if (this.#busy) this.#emit({ ev: "alive" }); }, every); this.#heartbeat.unref?.(); }
    if (opts.sessionId) this.#emit({ ev: "session", id: opts.sessionId });
    this.#announce();
  }

  #announce(): void {
    const { models, efforts } = this.#o;
    this.#emit({
      ev: "caps", steer: true, modes: ["auto", "plan"], defaultMode: "auto", compact: false,
      ...(models?.length ? { models: models.map((m) => ({ ...m, current: m.id === (this.#model ?? DEFAULT_MODEL) })) } : {}),
      ...(efforts?.length ? { efforts } : {}),
      ...(this.#effort ? { effort: this.#effort } : {}),
    });
  }

  get sessionId(): string { return this.#sessionId; }

  handle(cmd: Command): void {
    switch (cmd.cmd) {
      case "prompt": return this.#prompt(cmd);
      case "cancel": return this.#cancel();
      case "approve": return;
      case "compact": this.#emit({ ev: "error", msg: "This engine cannot compact on demand." }); return;
      case "model": return this.#useModel(cmd.id);
      case "effort": return this.#setEffort(cmd.level);
      case "load": this.#emit({ ev: "error", msg: "Start the program with --session <id> to continue a session." }); return;
    }
  }

  async idle(): Promise<void> {
    if (!this.#busy) return;
    await new Promise<void>((resolve) => this.#waiters.push(resolve));
  }

  close(): void {
    this.#closed = true;
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    if (this.#killTimer) clearTimeout(this.#killTimer);
    try { this.#child?.kill("SIGKILL"); } catch { /* already gone */ }
    this.#settle();
  }

  /** Messages written to the program that it never took: windows are told, so they do not show them as waiting for ever. */
  #dropPending(): void {
    const qids = [...this.#pending].flatMap((uuid) => { const q = this.#prompts.get(uuid)?.qid; return q ? [q] : []; });
    this.#pending.clear();
    if (qids.length) this.#emit({ ev: "dropped", qids });
  }

  #prompt(cmd: PromptCommand): void {
    if (cmd.qid && !this.#qids.isNew(cmd.qid)) return;
    if (cmd.mode === "ask") {
      this.#emit({ ev: "error", msg: "This computer's engine is a program you are signed in to, and it can only run in Auto or Plan: it cannot ask before each change." });
      this.#emit({ ev: "done", stop: "error" });
      return;
    }
    const mode: PermMode = cmd.mode ?? this.#mode;
    const effort = cmd.effort ?? this.#effort;
    // The mode and effort are process flags: change them only between turns, by restarting the agent on the same session.
    if (!this.#busy && this.#child && (mode !== this.#running?.mode || effort !== this.#running?.effort || this.#model !== this.#running?.model)) this.#stopChild();
    this.#mode = mode;
    this.#effort = effort;

    if (!this.#child && !this.#start()) return;
    const uuid = crypto.randomUUID();
    this.#tr.expect(uuid, cmd.qid);
    if (cmd.qid) { this.#prompts.set(uuid, { qid: cmd.qid, text: cmd.text, images: cmd.images?.length ?? 0 }); this.#emit({ ev: "queued", qid: cmd.qid, text: cmd.text, ...(cmd.images?.length ? { images: cmd.images.length } : {}) }); }
    this.#pending.add(uuid);
    this.#busy = true;
    const content = [...(cmd.text ? [{ type: "text", text: cmd.text }] : []), ...(cmd.images ?? []).map(imageBlock)];
    this.#write({ type: "user", uuid, message: { role: "user", content } });
  }

  #useModel(id: string): void {
    if (!this.#o.models?.length) { this.#emit({ ev: "error", msg: "This engine has only one model." }); return; }
    if (!this.#o.models.some((m) => m.id === id)) { this.#emit({ ev: "error", msg: `There is no model "${id}".` }); return; }
    // Chosen at once; a turn that is being answered finishes with the model it started with, and the next message uses the new one.
    this.#model = id === DEFAULT_MODEL ? undefined : id;
    this.#announce();
  }

  #setEffort(level: Effort | "auto"): void {
    if (level !== "auto" && !this.#o.efforts?.includes(level)) { this.#emit({ ev: "error", msg: this.#o.efforts?.length ? `This model does not have the effort level ${level}.` : "This model has no effort setting." }); return; }
    this.#effort = level === "auto" ? undefined : level;
    this.#announce();
  }

  #cancel(): void {
    if (!this.#busy || !this.#child) return;
    this.#tr.interrupting = true;
    this.#write({ type: "control_request", request_id: crypto.randomUUID(), request: { subtype: "interrupt" } });
    this.#killTimer = setTimeout(() => { try { this.#child?.kill("SIGKILL"); } catch { /* gone */ } }, this.#o.cancelGraceMs ?? 5000);
  }

  #start(): boolean {
    const argv = buildArgv({
      command: this.#o.command, ...(this.#o.args ? { args: this.#o.args } : {}), ...(this.#model ? { model: this.#model } : {}),
      mode: this.#mode, ...(this.#effort ? { effort: this.#effort } : {}), ...(this.#sessionId ? { resume: this.#sessionId } : {}),
      ...(this.#o.persona ? { persona: this.#o.persona } : {}),
      ...(this.#o.guard ? { guard: this.#o.guard } : {}),
    });
    let child: Child;
    try {
      child = Bun.spawn(argv, { cwd: this.#o.cwd, env: { ...process.env, ...this.#o.env }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    } catch (e) {
      this.#emit({ ev: "error", msg: `Could not start "${this.#o.command}": ${e instanceof Error ? e.message : String(e)}` });
      this.#emit({ ev: "done", stop: "error" });
      return false;
    }
    this.#child = child;
    this.#running = { mode: this.#mode, effort: this.#effort, model: this.#model };
    this.#stderr = "";
    // The program is starting: until it says anything, the person is told so (then "thinking" begins), as when a conversation is opened on a new machine.
    this.#starting = true;
    this.#emit({ ev: "phase", name: "starting" });
    void this.#read(child);
    void this.#readStderr(child);
    void child.exited.then((code) => this.#exited(child, code));
    return true;
  }

  /** Stop the process between turns (to restart it with other flags). Its exit is expected, so nothing is reported. */
  #stopChild(): void {
    const child = this.#child;
    this.#child = undefined;
    this.#running = undefined;
    try { child?.kill("SIGTERM"); } catch { /* gone */ }
  }

  async #read(child: Child): Promise<void> {
    const splitter = new LineSplitter();
    const decoder = new TextDecoder();
    const handle = (line: string): void => {
      let json: unknown;
      try { json = JSON.parse(line); } catch { return; } // not ours (a banner, a warning)
      for (const e of this.#tr.feed(json)) this.#deliver(e);
    };
    try {
      for await (const chunk of child.stdout as unknown as AsyncIterable<Uint8Array>) {
        try { for (const line of splitter.push(decoder.decode(chunk, { stream: true }))) handle(line); } catch { /* an over-long line: skip it */ }
      }
      for (const line of splitter.flush()) handle(line);
    } catch { /* the stream closed under us */ }
  }

  async #readStderr(child: Child): Promise<void> {
    try { for await (const chunk of child.stderr as unknown as AsyncIterable<Uint8Array>) this.#stderr = (this.#stderr + new TextDecoder().decode(chunk)).slice(-2000); } catch { /* closed */ }
  }

  #deliver(e: EngineEvent): void {
    if (this.#starting) { this.#starting = false; this.#emit({ ev: "phase", name: "" }); }
    if (e.ev === "session") this.#sessionId = e.id;
    if (e.ev === "done") {
      if (this.#killTimer) { clearTimeout(this.#killTimer); this.#killTimer = undefined; }
      if (this.#pending.size > 0 && e.stop === "end_turn") return; // more messages are queued: the agent runs them next, so the turn goes on
      this.#dropPending();
      this.#emit(e);
      this.#busy = false;
      this.#settle();
      return;
    }
    this.#emit(e);
  }

  #exited(child: Child, code: number): void {
    if (this.#child !== child) return; // replaced on purpose
    this.#child = undefined;
    this.#running = undefined;
    if (this.#killTimer) { clearTimeout(this.#killTimer); this.#killTimer = undefined; }
    if (this.#closed) return;
    if (this.#busy) {
      const cancelled = this.#tr.interrupting;
      this.#tr.interrupting = false;
      if (!cancelled) {
        const detail = this.#stderr.trim().split("\n").slice(-3).join(" ").slice(0, 300);
        this.#emit({ ev: "error", msg: `The agent process ended unexpectedly (exit ${code})${detail ? `: ${detail}` : ""}` });
      }
      this.#dropPending();
      this.#emit({ ev: "done", stop: cancelled ? "cancelled" : "error" });
      this.#busy = false;
      this.#settle();
    }
  }

  #write(message: unknown): void {
    try {
      const stdin = this.#child?.stdin as { write(data: string): unknown; flush?(): unknown } | undefined;
      stdin?.write(`${JSON.stringify(message)}\n`);
      stdin?.flush?.();
    } catch { /* the process is gone; its exit is handled in #exited */ }
  }

  #settle(): void { for (const w of this.#waiters.splice(0)) w(); }
  #emit(event: EngineEvent): void { this.#o.emit(event); }
}
