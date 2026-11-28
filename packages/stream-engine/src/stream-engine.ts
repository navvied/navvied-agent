/**
 * An engine that drives an external agent process instead of running its own loop — for example a vendor command-line
 * agent the user has already signed in to with their subscription. The login belongs to that program; this adapter never
 * sees or stores a token. It speaks the navvied protocol to the front-end and the agent's JSON-line stream to the process.
 */
import { ChildEnv, bunSpawn } from "@navvied/engine";
import { StepClock } from "./step-clock.ts";
import { LineSplitter, RecentIds, type Command, type Effort, type EngineEvent, type ModelInfo, type PermMode, type PromptCommand } from "@navvied/protocol";
import { ALLOW, ALLOW_ALWAYS, ApprovalBroker, DENY, EDIT, approvalChange, approvalOptions, Outside, fromOutsideName, hardBlock, judge, launch, secretsNow, withOrigin, type AgentEngine, type Rules } from "@navvied/engine";
import { AskServer, type AskReply, type AskedCall } from "./ask-channel.ts";
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
  /** The entry of the configuration this engine was made for: with no list of models, it is the one model every window is told is in use. */
  entry?: { id: string; name: string };
  cwd: string;
  window: number;
  emit: (event: EngineEvent) => void;
  sessionId?: string;
  persona?: string;
  /** A command the program runs before each of its tools. */
  guard?: string;
  /** The person's permission rules, which the hook's questions are judged by (with the mode). */
  rules?: Rules;
  env?: Record<string, string>;
  signIn?: readonly string[];
  /** How long to wait for the agent to stop after a cancel before killing it (ms, default 5000). */
  cancelGraceMs?: number;
  heartbeatMs?: number;
}

type Child = Bun.Subprocess<"pipe", "pipe", "pipe">;

/** The call the engine makes of its own guard before it starts a program, to see that the guard starts and answers on this computer. */
export const GUARD_PROBE = "navvied-guard-probe";

/** The tools of the program that only look, so a mode that asks about everything else does not ask about them. */
const READ_ONLY = new Set(["Read", "Glob", "Grep", "LS", "NotebookRead", "WebFetch", "WebSearch", "TodoWrite", "BashOutput"]);

/** What a card says the program is about to do. */
function titleOf(name: string, args: Record<string, unknown>): string {
  const text = (v: unknown): string => (typeof v === "string" ? v.split("\n")[0]!.slice(0, 200) : "");
  if (name === "Bash") return `Run ${text(args.command)}`;
  if (name === "Write" || name === "Edit") return `${name === "Write" ? "Write" : "Edit"} ${text(args.file_path)}`;
  if (name === "WebFetch") return `Fetch ${text(args.url)}`;
  return `Use ${name}`;
}

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
  readonly #clock = new StepClock();
  readonly #approvals = new ApprovalBroker();
  /** What the person said "do not ask again" to. */
  readonly #allowed = new Set<string>();
  /** What this turn of the program has read from outside. */
  readonly #outside = new Outside();
  readonly #ask = new AskServer((call, gone) => this.#decide(call, gone));
  /** The guard has been seen to start and answer: until then the program is not started. */
  #guardOk = false;

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
      ev: "caps", steer: true, modes: ["ask", "edits", "plan", "auto", "bypass"], defaultMode: "auto", compact: false,
      ...(models?.length ? { models: models.map((m) => ({ ...m, current: m.id === (this.#model ?? DEFAULT_MODEL) })) } : this.#o.entry ? { models: [{ ...this.#o.entry, current: true }] } : {}),
      ...(efforts?.length ? { efforts } : {}),
      ...(this.#effort ? { effort: this.#effort } : {}),
    });
  }

  get sessionId(): string { return this.#sessionId; }

  handle(cmd: Command): void {
    switch (cmd.cmd) {
      case "prompt": return this.#prompt(cmd);
      case "cancel": return this.#cancel();
      case "approve": this.#approvals.answer(cmd.id, cmd.optionId, cmd.input); return;
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
    this.#approvals.denyAll();
    this.#ask.close();
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
    const mode: PermMode = cmd.mode ?? this.#mode;
    const effort = cmd.effort ?? this.#effort;
    // The mode and effort are process flags: change them only between turns, by restarting the agent on the same session.
    if (!this.#busy && this.#child && (mode !== this.#running?.mode || effort !== this.#running?.effort || this.#model !== this.#running?.model)) this.#stopChild();
    this.#mode = mode;
    this.#effort = effort;

    // A program is not started until its guard has been seen to work on this computer: a guard that cannot start is, to the program, an error
    // that does not stop the tool, so nothing would stand in the way. That is checked once; messages that come meanwhile wait their turn.
    if (!this.#child && this.#o.guard && !this.#guardOk) {
      this.#busy = true;
      this.#checked = this.#checked.then(async () => {
        if (!this.#guardOk) {
          const why = await this.#checkGuard();
          if (why) {
            this.#emit({ ev: "error", msg: `navvied's guard could not be started for this program, so nothing was run: ${why}` });
            this.#emit({ ev: "done", stop: "error" });
            this.#busy = false;
            this.#settle();
            return;
          }
          this.#guardOk = true;
        }
        this.#sendPrompt(cmd);
      });
      return;
    }
    this.#sendPrompt(cmd);
  }

  #checked: Promise<void> = Promise.resolve();

  #sendPrompt(cmd: PromptCommand): void {
    if (!this.#child && !this.#start()) { this.#busy = false; this.#settle(); return; }
    const uuid = crypto.randomUUID();
    this.#outside.say(cmd.text);
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
    this.#approvals.denyAll();
    if (!this.#busy || !this.#child) return;
    this.#tr.interrupting = true;
    this.#write({ type: "control_request", request_id: crypto.randomUUID(), request: { subtype: "interrupt" } });
    this.#killTimer = setTimeout(() => { try { this.#child?.kill("SIGKILL"); } catch { /* gone */ } }, this.#o.cancelGraceMs ?? 5000);
  }

  #handed(): ChildEnv { return ChildEnv.scrubbed(process.env, this.#o.signIn ? { keep: this.#o.signIn } : {}).with(this.#o.env); }

  #start(): boolean {
    const argv = buildArgv({
      command: this.#o.command, ...(this.#o.args ? { args: this.#o.args } : {}), ...(this.#model ? { model: this.#model } : {}),
      mode: this.#mode, ...(this.#effort ? { effort: this.#effort } : {}), ...(this.#sessionId ? { resume: this.#sessionId } : {}),
      ...(this.#o.persona ? { persona: this.#o.persona } : {}),
      ...(this.#o.guard ? { guard: this.#o.guard } : {}),
    });
    let child: Child;
    try {
      child = bunSpawn(launch(argv), { cwd: this.#o.cwd, env: this.#handed().with(this.#o.guard ? this.#ask.listen() : {}), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
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

  /**
   * Runs the guard once the way the program will (through a shell, with the engine's address in the environment) with a call of no consequence,
   * and says why not if it cannot start, ends with an error, or does not answer in time. Nothing is allowed by it: the engine answers that call "say nothing".
   */
  async #checkGuard(): Promise<string | undefined> {
    const shell = process.platform === "win32" ? (Bun.which("bash") ? ["bash", "-c"] : ["cmd", "/d", "/s", "/c"]) : ["sh", "-c"];
    let child: Bun.Subprocess<Uint8Array, "pipe", "pipe">;
    try {
      child = bunSpawn([...shell, this.#o.guard!], { cwd: this.#o.cwd, env: this.#handed().with(this.#ask.listen()), stdin: new TextEncoder().encode(JSON.stringify({ tool_name: GUARD_PROBE, tool_input: {}, cwd: this.#o.cwd })), stdout: "pipe", stderr: "pipe" });
    } catch (e) { return e instanceof Error ? e.message : String(e); }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, 20_000);
    const [out, err, code] = await Promise.all([new Response(child.stdout as ReadableStream).text(), new Response(child.stderr as ReadableStream).text(), child.exited]);
    clearTimeout(timer);
    if (code === 0 && !out.trim()) return undefined;
    return (err.trim().split("\n").pop() || out.trim().split("\n").pop() || `it ended with code ${code}`).slice(0, 300);
  }

  /**
   * What a program's hook asks before each tool it runs: judged by the same rules as the built-in engine's (`judge`), and where the person is
   * to be asked, asked in the same card with the same answers. A tool that is let through is said so out loud, which is what lets the program
   * run it without asking itself; in Plan and Bypass the program's own mode stays in charge and nothing is said.
   */
  async #decide(call: AskedCall, gone: AbortSignal): Promise<AskReply> {
    const asked = typeof call.tool_name === "string" ? call.tool_name : "";
    if (asked === GUARD_PROBE) return { decision: "pass" };
    const name = asked === "MultiEdit" || asked === "NotebookEdit" ? "Edit" : asked;
    const args = typeof call.tool_input === "object" && call.tool_input !== null && !Array.isArray(call.tool_input) ? call.tool_input as Record<string, unknown> : {};
    const cwd = typeof call.cwd === "string" && call.cwd ? call.cwd : this.#o.cwd;
    const mode = this.#mode;
    const settled: AskReply = mode === "plan" || mode === "bypass" ? { decision: "pass" } : { decision: "allow" };
    this.#outside.record(name, args, cwd);
    const judged = judge({ mode, tool: { name, readOnly: READ_ONLY.has(asked) }, args, cwd, rules: this.#o.rules, allowed: this.#allowed, knownUrl: () => true, outside: this.#outside, secrets: secretsNow });
    if (judged.kind === "stop") return { decision: "deny", message: judged.message };
    if (judged.kind === "go") return settled;

    const { scope, risk } = judged;
    const { id, answer } = this.#approvals.open();
    const editable = name === "Bash" && typeof args.command === "string" ? args.command : undefined;
    const change = approvalChange(name, args);
    const stopped = (): void => { this.#approvals.answer(id, DENY); };
    gone.addEventListener("abort", stopped, { once: true });
    this.#emit({ ev: "approval", id, title: withOrigin(titleOf(name, args), judged.copied), options: approvalOptions(scope.phrase, editable), ...(typeof call.tool_use_id === "string" ? { tool: call.tool_use_id } : {}), ...(change ? { change } : {}), ...(risk ? { risk: risk.reason } : {}) });
    const given = await answer;
    gone.removeEventListener("abort", stopped);
    if (given.optionId === ALLOW_ALWAYS) { for (const k of scope.keys ?? [scope.key]) this.#allowed.add(k); return settled; }
    if (given.optionId === EDIT && editable !== undefined && given.input?.trim()) {
      const edited = { ...args, command: given.input.trim() };
      const again = hardBlock(name, edited, cwd);
      if (again) return { decision: "deny", message: `Blocked: ${again}. navvied never does this.` };
      const rule = this.#o.rules?.check(name, edited);
      if (rule?.kind === "deny") return { decision: "deny", message: `Blocked by the permission rule ${rule.rule}.` };
      return { decision: "allow", input: edited };
    }
    if (given.optionId === ALLOW || given.optionId === EDIT) return settled;
    const said = given.input?.trim();
    return { decision: "deny", message: said ? `Not run. The person said: ${said}` : "The user denied this action." };
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
    if (e.ev === "tool" && e.status !== "running" && typeof e.output === "string") {
      if (fromOutsideName(e.name)) this.#outside.note(e.output);
      else if (e.name === "Read" || e.name === "Grep") this.#outside.read(e.output);
    }
    if (e.ev === "done") {
      if (this.#killTimer) { clearTimeout(this.#killTimer); this.#killTimer = undefined; }
      if (this.#pending.size > 0 && e.stop === "end_turn") return; // more messages are queued: the agent runs them next, so the turn goes on
      this.#dropPending();
      this.#outside.reset();
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
  #emit(event: EngineEvent): void { this.#o.emit(this.#clock.stamp(event)); }
}
