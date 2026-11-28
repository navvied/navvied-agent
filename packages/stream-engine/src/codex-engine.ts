/**
 * An engine that drives the Codex command-line program the user has already signed in to. Each message is one run of
 * `codex exec --json`; the conversation continues by resuming its thread. The login belongs to that program, and this
 * adapter never sees or stores a token.
 */
import { StepClock } from "./step-clock.ts";
import type { ChildProcess } from "node:child_process";
import { ChildEnv, spawn } from "@navvied/engine";
import { LineSplitter, RecentIds, type Command, type Effort, type EngineEvent, type ModelInfo, type PermMode, type PromptCommand } from "@navvied/protocol";
import { killTree, launch, usesProcessGroups, type AgentEngine } from "@navvied/engine";
import { CodexTranslator, friendlyFailure } from "./codex-translate.ts";
import { DEFAULT_MODEL } from "./stream-engine.ts";

export interface CodexEngineOptions {
  command: string;
  args?: string[];
  model?: string;
  cwd: string;
  window: number;
  emit: (event: EngineEvent) => void;
  /** Continue this thread instead of starting a new one. */
  sessionId?: string;
  env?: Record<string, string>;
  signIn?: readonly string[];
  /** The models a person can switch to; `id` is what the program is given after -m. */
  models?: ModelInfo[];
  /** The reasoning effort levels the program accepts. */
  efforts?: Effort[];
  /** Who the agent is. Said once, at the start of a new thread, because the thread remembers it. */
  persona?: string;
  /** The entry of the configuration this engine was made for: with no list of models, it is the one model every window is told is in use. */
  entry?: { id: string; name: string };
}

const SANDBOX: Record<PermMode, string> = { auto: "workspace-write", plan: "read-only", ask: "workspace-write", edits: "workspace-write", bypass: "danger-full-access" };

/** The command line for one message. The prompt itself is sent on standard input, whatever its length or quotes. */
export function codexArgv(o: { command: string; args?: string[]; model?: string; effort?: Effort; mode: PermMode; thread?: string }): string[] {
  return [
    o.command, ...(o.args ?? []), "exec", ...(o.thread ? ["resume", o.thread] : []),
    "--json", "--skip-git-repo-check", "-c", `sandbox_mode="${SANDBOX[o.mode]}"`, ...(o.model ? ["-m", o.model] : []), ...(o.effort ? ["-c", `model_reasoning_effort="${o.effort}"`] : []), "-",
  ];
}

export class CodexEngine implements AgentEngine {
  readonly #o: CodexEngineOptions;
  readonly #qids = new RecentIds();
  readonly #queue: PromptCommand[] = [];
  readonly #waiters: (() => void)[] = [];
  #tr: CodexTranslator;
  #child: ChildProcess | undefined;
  #mode: PermMode = "auto";
  #model: string | undefined;
  #effort: Effort | undefined;
  #busy = false;
  #cancelled = false;
  #closed = false;
  readonly #clock = new StepClock();

  constructor(opts: CodexEngineOptions) {
    this.#o = opts;
    this.#model = opts.model;
    this.#tr = new CodexTranslator(opts.window);
    this.#tr.threadId = opts.sessionId ?? "";
    if (opts.sessionId) this.#emit({ ev: "session", id: opts.sessionId });
    this.#announce();
  }

  #announce(): void {
    const { models, efforts } = this.#o;
    this.#emit({
      ev: "caps", steer: false, modes: ["auto", "plan"], defaultMode: "auto", compact: false,
      ...(models?.length ? { models: models.map((m) => ({ ...m, current: m.id === (this.#model ?? DEFAULT_MODEL) })) } : this.#o.entry ? { models: [{ ...this.#o.entry, current: true }] } : {}),
      ...(efforts?.length ? { efforts } : {}),
      ...(this.#effort ? { effort: this.#effort } : {}),
    });
  }

  get sessionId(): string { return this.#tr.threadId; }

  handle(cmd: Command): void {
    switch (cmd.cmd) {
      case "prompt": return this.#prompt(cmd);
      case "cancel": return this.#cancel();
      case "approve": return;
      case "compact": this.#emit({ ev: "error", msg: "This engine cannot compact on demand." }); return;
      case "model": return this.#useModel(cmd.id);
      case "effort": return this.#setEffort(cmd.level);
      case "load": this.#emit({ ev: "error", msg: "Start the program with --session <id> to continue a thread." }); return;
    }
  }

  async idle(): Promise<void> {
    if (!this.#busy) return;
    await new Promise<void>((resolve) => this.#waiters.push(resolve));
  }

  close(): void {
    this.#closed = true;
    this.#queue.length = 0;
    if (this.#child) killTree(this.#child);
    this.#settle();
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

  #emit(e: EngineEvent): void { this.#o.emit(this.#clock.stamp(e)); }

  #settle(): void { for (const w of this.#waiters.splice(0)) w(); }

  #prompt(cmd: PromptCommand): void {
    if (cmd.qid && !this.#qids.isNew(cmd.qid)) return;
    if (cmd.mode === "ask") {
      this.#emit({ ev: "error", msg: "This computer's engine is a program you are signed in to, and it can only run in Auto or Plan: it cannot ask before each change." });
      this.#emit({ ev: "done", stop: "error" });
      return;
    }
    if (cmd.mode) this.#mode = cmd.mode;
    if (this.#busy) { this.#queue.push(cmd); if (cmd.qid) this.#emit({ ev: "queued", qid: cmd.qid, text: cmd.text, ...(cmd.images?.length ? { images: cmd.images.length } : {}) }); return; }
    this.#run(cmd);
  }

  #dropQueue(): void {
    const qids = this.#queue.flatMap((q) => (q.qid ? [q.qid] : []));
    this.#queue.length = 0;
    if (qids.length) this.#emit({ ev: "dropped", qids });
  }

  #cancel(): void {
    this.#dropQueue();
    if (!this.#busy || !this.#child) return;
    this.#cancelled = true;
    killTree(this.#child);
  }

  #run(cmd: PromptCommand): void {
    this.#busy = true;
    this.#cancelled = false;
    if (cmd.qid) {
      this.#emit({ ev: "user", qid: cmd.qid, text: cmd.text, ...(cmd.images?.length ? { images: cmd.images.length } : {}) });
      this.#emit({ ev: "taken", qid: cmd.qid });
    }
    const argv = codexArgv({ command: this.#o.command, ...(this.#o.args ? { args: this.#o.args } : {}), ...(this.#model ? { model: this.#model } : {}), ...(this.#effort ? { effort: this.#effort } : {}), mode: this.#mode, ...(this.#tr.threadId ? { thread: this.#tr.threadId } : {}) });
    let child: ChildProcess;
    try {
      const [program, ...args] = launch(argv);
      child = spawn(program!, args, { cwd: this.#o.cwd, env: ChildEnv.scrubbed(process.env, this.#o.signIn ? { keep: this.#o.signIn } : {}).with(this.#o.env), detached: usesProcessGroups(), windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      this.#emit({ ev: "error", msg: `Could not start "${this.#o.command}": ${e instanceof Error ? e.message : String(e)}` });
      this.#finish("error");
      return;
    }
    this.#child = child;
    let ended = false;
    let started = false;
    this.#emit({ ev: "phase", name: "starting" });
    let stderr = "";
    const splitter = new LineSplitter();
    const feed = (line: string): void => {
      let json: unknown;
      try { json = JSON.parse(line); } catch { return; }
      for (const e of this.#tr.feed(json)) {
        if (!started) { started = true; this.#emit({ ev: "phase", name: "" }); }
        if (e.ev === "done") { ended = true; this.#finish(e.stop, e); continue; }
        this.#emit(e);
      }
    };
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => { try { for (const line of splitter.push(chunk)) feed(line); } catch { /* an over-long line: skip it */ } });
    child.stdout?.on("end", () => { for (const line of splitter.flush()) feed(line); });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-2000); });
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(`${this.#o.persona && !this.#tr.threadId ? `${this.#o.persona}\n\n---\n\n` : ""}${cmd.text}\n`);
    child.on("error", (e) => {
      if (ended) return;
      ended = true;
      this.#emit({ ev: "error", msg: `Could not start "${this.#o.command}": ${e.message}` });
      this.#finish("error");
    });
    child.on("close", () => {
      if (this.#child === child) this.#child = undefined;
      if (ended) return;
      ended = true;
      if (this.#cancelled) { this.#finish("cancelled"); return; }
      const detail = stderr.trim().split("\n").filter((l) => !/^\d{4}-\d\d-\d\dT/.test(l)).pop();
      this.#emit({ ev: "error", msg: friendlyFailure(detail || "Codex ended without answering.") });
      this.#finish("error");
    });
  }

  #finish(stop: string, event?: Extract<EngineEvent, { ev: "done" }>): void {
    this.#emit(event ?? { ev: "done", stop });
    this.#busy = false;
    const next = this.#queue.shift();
    if (next && !this.#closed) { this.#run(next); return; }
    this.#settle();
  }
}
