/**
 * The engine: one conversation, one agent loop. It receives protocol commands and emits protocol events; everything it needs
 * from the outside (model provider, session store, tools, clock) is passed in, so a whole run can be tested against a script.
 */
import { historyOf } from "./store.ts";
import { join, resolve } from "node:path";
import { REFUSED, RecentIds, type Command, type Effort, type EngineEvent, type FileNote, type ModelInfo, type PermMode, type PromptCommand, type SessionKind, type StopReason, type ToolOutcome, type TurnTokens } from "@navvied/protocol";
import { ALLOW, ALLOW_ALWAYS, ApprovalBroker, EDIT, approvalOptions } from "./approvals.ts";
import { approvalScope } from "./approval-scope.ts";
import type { Checkpoint, Checkpoints } from "./checkpoints.ts";
import type { AgentEngine } from "./contract.ts";
import { KEEP_TAIL, compactMessages, estimateTokens, shouldCompact } from "./context.ts";
import { parseLenient } from "./lenient-json.ts";
import type { Hooks } from "./hooks.ts";
import type { MemoryPaths } from "./memory.ts";
import { approvalChange } from "./approval-change.ts";
import { Jobs } from "./jobs.ts";
import { Redactor, registerSecrets } from "./redact.ts";
import { forget, type ShellState } from "./tools/shell-state.ts";
import { skillsPrompt, type SkillInfo } from "./skills.ts";
import { TextToolCalls, dollarCommand } from "./text-tool-calls.ts";
import type { Backend } from "./backend.ts";
import { needsApproval, toolsFor } from "./permissions.ts";
import { riskOf } from "./risk.ts";
import { isConfined, profileTools } from "./profiles.ts";
import { hardBlock, type Rules } from "./rules.ts";
import { asksAboutProgram, systemPrompt } from "./prompt.ts";
import { PLAN_TOOL_NAME, defaultTools } from "./tools/index.ts";
import { outputBudget, withinBudget } from "./tools/util.ts";
import { receive } from "./attachments.ts";
import { Vault } from "./redact.ts";
import { tmpdir } from "node:os";
import { AGENT_TOOL_NAME, agentTool } from "./tools/agent.ts";
import type { AgentDef } from "./agents.ts";
import type { Message, ModelReply, Part, Provider, Recall, SessionStore, Tool, ToolCall, WebProxy } from "./types.ts";

/** What the engine needs to let a person switch models in the middle of a conversation. */
export interface ModelSwitch {
  /** What can be switched to. The engine marks the one in use. */
  models: ModelInfo[];
  /** The id of the one in use. */
  current: string;
  /** The effort levels the model in use supports; none when it has no such setting. */
  efforts?: Effort[];
  /** What it takes to use another: its provider and window, and the effort levels it supports. */
  use(id: string): { provider: Provider; window: number; efforts?: Effort[]; persona?: string; reference?: string; vision?: boolean } | { error: string };
}

export interface EngineOptions {
  provider: Provider;
  /** Where the files a person attaches are saved: one folder per session below it (default: a folder of the system's temporary files). */
  attachments?: string;
  /** The effort levels the model supports, for an engine with one model (with a switcher, the switcher says). */
  efforts?: Effort[];
  /** Whether the model can see pictures. Absent: not known, so a picture is sent and a refusal is turned into a plain message. */
  vision?: boolean;
  cwd: string;
  window: number;
  emit: (event: EngineEvent) => void;
  store?: SessionStore;
  /** Continue a saved session (needs `store`). */
  sessionId?: string;
  persona?: string;
  /** Keys the program knows from its configuration: they are hidden from everything a command prints. */
  secrets?: string[];
  /** What the person may ask about this program (its commands, modes, files): put in the prompt only for a request that asks about it. */
  reference?: string;
  instructions?: () => string | undefined;
  checkpoints?: Checkpoints;
  tools?: Tool[];
  /** Where Bash runs its commands: a container or another machine instead of this computer. */
  backend?: Backend;
  /** Nobody can be asked (a helper): what would be asked about is refused instead. */
  noQuestions?: boolean;
  /** The person's earlier conversations, for the Recall tool. */
  recall?: Recall;
  allowPrivateNetwork?: boolean;
  /** Model calls allowed in one turn before the engine stops (default 60). */
  maxSteps?: number;
  /** Heartbeat interval while working, ms (default 15000; 0 disables). */
  heartbeatMs?: number;
  now?: () => Date;
  switcher?: ModelSwitch;
  /** A search server to use instead of the public search page (it must answer in JSON, as SearXNG does). */
  search?: { url?: string };
  /** The service that fetches and searches the web for a session that has no network of its own. */
  webProxy?: WebProxy;
  /** The skills in effect, read again each turn so a new one is seen without a restart. */
  skills?: () => SkillInfo[];
  /** Commands the person runs around what the agent does. */
  hooks?: Hooks;
  /** Helpers the person defined in Markdown files (see agents.ts). */
  agents?: AgentDef[];
  /** The person's own allow / ask / deny rules (see rules.ts). */
  rules?: Rules;
  /** Where notes are kept between conversations. */
  memory?: MemoryPaths;
  /** What the conversation is for (default `agent`). A `chat` works in `cwd` only, offers a smaller set of tools and asks the person nothing. */
  kind?: SessionKind;
  /** The program runs inside a sandbox, so a chat may run commands too. */
  sandboxed?: boolean;
  /** The one model in use, for a page that shows it, when there is no list to switch between. */
  model?: ModelInfo;
}

/** `attached` is what the model is told about the files, `parts` the pictures and PDFs that go with it, `files` what the person's window is told. */
interface Queued { qid?: string; text: string; images: NonNullable<PromptCommand["images"]>; attached?: string; parts?: Part[]; files?: FileNote[] }

/** `{"path": "...", "limit": 0}`: what a call to a tool looks like, from its parameter schema. */
function exampleArguments(schema: Record<string, unknown>): string {
  const props = (schema.properties ?? {}) as Record<string, { type?: string }>;
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : Object.keys(props).slice(0, 2);
  const sample = (type: string | undefined): string => (type === "number" ? "0" : type === "boolean" ? "true" : '"..."');
  return `{${required.map((k) => `"${k}": ${sample(props[k]?.type)}`).join(", ")}}`;
}

/** The names models invent for the command tool, and what they stand for. */
const ALIASES: Record<string, string> = { bash: "Bash", shell: "Bash", terminal: "Bash", run: "Bash", execute_bash: "Bash", run_command: "Bash", exec: "Bash", sh: "Bash" };
const squash = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Tools that are named in the prompt, without their definitions, when the request has not brought them in. */
const EXTRA = new Set(["WebSearch", "WebFetch", "Agent", "Remember", "TodoWrite"]);

/** A context window this small, or smaller, marks a model that needs a lighter touch. */
export const SMALL_WINDOW = 40_000;
/** The steps a helper may take before it must answer. */
/** How often what a running command printed is sent on, and the most of it that is. */
const LIVE_EVERY_MS = 150;
const LIVE_MOST = 200_000;
const HELPER_STEPS = 25;

const asParts = (q: Queued): string | Part[] => {
  const text = [q.text, q.attached].filter(Boolean).join("\n\n");
  const rest: Part[] = [...q.images.map((i) => ({ type: "image" as const, mime: i.mime, data: i.data })), ...(q.parts ?? [])];
  return rest.length ? [...(text ? [{ type: "text" as const, text }] : []), ...rest] : text;
};

/** The arguments of Edit and Write that are text going into a file. */
const CHANGED = ["content", "old_string", "new_string"];

/** The server turned the request down because of the effort field: a 400 that names it, or a parameter it does not know. */
const refusesEffort = (e: unknown): boolean => (e as { status?: number } | undefined)?.status === 400 && /effort|reasoning|unknown (parameter|field|argument|name)|unrecognized (parameter|field|request argument)|unsupported (parameter|field)|extra inputs|additional properties|not permitted/i.test(e instanceof Error ? e.message : "");

/** The words a person is shown when the model cannot see pictures. */
const BLIND = "This model cannot see pictures, so they were not sent.";
const REFUSES_PICTURES = /image|picture|vision|multimodal|multi-modal|modalit/i;

/** Run a collaborator's code that must never be able to stop a turn: a failure counts as "no result". */
function attempt<T>(fn: () => T): T | undefined {
  try { return fn(); } catch { return undefined; }
}

export class Engine implements AgentEngine {
  sessionId: string;
  readonly #o: Required<Pick<EngineOptions, "provider" | "cwd" | "window" | "emit" | "maxSteps" | "allowPrivateNetwork">> & EngineOptions;
  readonly #tools: Tool[];
  readonly #disposers: (() => void)[] = [];
  #loading: Promise<void>[] = [];
  readonly #approvals = new ApprovalBroker();
  readonly #queue: Queued[] = [];
  /** A model chosen while a turn was being answered: it is used from the next one. */
  #wantModel: string | undefined;
  #messages: Message[] = [];
  #mode: PermMode = "auto";
  get #kind(): SessionKind { return this.#o.kind ?? "agent"; }
  #effort: Effort | undefined;
  #provider: Provider;
  #window: number;
  #vision: boolean | undefined;
  #persona: string | undefined;
  #reference: string | undefined;
  #model: string | undefined;
  #efforts: Effort[] | undefined;
  /** Models that turned the effort field down in this session: none is offered for them again. */
  readonly #noEffort = new Set<string>();
  #busy = false;
  readonly #qids = new RecentIds();
  /** The prompt that started the running turn, and what the turn has used so far. */
  #turnQid: string | undefined;
  #turnTokens: TurnTokens = { in: 0, out: 0, calls: 0 };
  /** The first message of the session has been through the hooks. */
  #hooked = false;
  #cancelled = false;
  /** Kinds of action the person said not to ask about again, until this engine closes. */
  readonly #allowed = new Set<string>();
  readonly #jobs = new Jobs((e) => this.#emit(e));
  /** The secrets this conversation has met in files and commands, behind the marks that stand for them. */
  readonly #vault = new Vault();
  readonly #shell: ShellState = {};
  /** Tools the model has called, which stay offered for the rest of the conversation even when the request that brought them is long past. */
  readonly #called = new Set<string>();
  readonly #closing = new AbortController();
  #abort = new AbortController();
  #lastContext = 0;
  #written = new Set<string>();
  #checkpoint: Checkpoint | undefined;
  #running: Promise<void> = Promise.resolve();
  #heartbeat: ReturnType<typeof setInterval> | undefined;

  constructor(opts: EngineOptions) {
    this.#o = { maxSteps: 60, allowPrivateNetwork: false, ...opts };
    this.#provider = opts.provider;
    this.#window = opts.window;
    this.#vision = opts.vision;
    registerSecrets(opts.secrets ?? []);
    this.#persona = opts.persona;
    this.#reference = opts.reference;
    this.#model = opts.switcher?.current;
    this.#efforts = opts.switcher?.efforts ?? opts.efforts;
    this.#tools = profileTools(opts.kind ?? "agent", opts.tools ?? defaultTools(), { sandboxed: opts.sandboxed === true }).map((t) => (t.name === AGENT_TOOL_NAME && opts.agents?.length ? agentTool(opts.agents) : t));
    this.sessionId = opts.sessionId ?? crypto.randomUUID();
    if (opts.sessionId && opts.store) this.#messages = opts.store.load(opts.sessionId) ?? [];
    const every = opts.heartbeatMs ?? 15_000;
    if (every > 0) {
      this.#heartbeat = setInterval(() => { if (this.#busy) this.#emit({ ev: "alive" }); }, every);
      this.#heartbeat.unref?.();
    }
    this.#emit({ ev: "session", id: this.sessionId });
    this.#announce();
    if (this.#messages.length) this.#emit({ ev: "usage", ctx: estimateTokens(this.#messages), win: this.#window, out: 0 });
  }

  /** Feed one command. Returns at once; work continues in the background (see {@link idle}). */
  handle(cmd: Command): void {
    switch (cmd.cmd) {
      case "prompt": return this.#prompt(cmd);
      case "cancel": return this.#cancel();
      case "job.stop": this.#jobs.stop(cmd.id); return;
      case "approve": this.#approvals.answer(cmd.id, cmd.optionId, cmd.input); return;
      case "compact": return this.#compactCommand();
      case "model": return this.#useModel(cmd.id);
      case "effort": return this.#setEffort(cmd.level);
      case "load": return this.#load(cmd.id);
      case "sessions": return this.#emit({ ev: "sessions", items: this.#o.store?.list?.() ?? [] });
      case "checkpoints": return this.#listCheckpoints();
      case "restore": return this.#restore(cmd.id, cmd.preview === true);
    }
  }

  /** Add tools after the engine has started, such as those of connected programs. They are offered from the next step. `dispose` runs when the engine closes. */
  addTools(tools: Tool[], dispose?: () => void): void {
    for (const t of tools) if (!this.#tools.some((x) => x.name === t.name)) this.#tools.push(t);
    if (dispose) this.#disposers.push(dispose);
  }

  /** Tools that are still being connected. The first step of the next turn waits for them, so no turn starts without tools that are about to arrive. Programs that fail are reported as errors, and the rest go on. */
  loadTools(load: Promise<{ tools: Tool[]; close(): void; problems?: { server: string; reason: string }[] }>): void {
    this.#loading.push(load.then((c) => {
      if (this.#closing.signal.aborted) { attempt(() => c.close()); return; }
      this.addTools(c.tools, () => c.close());
      for (const p of c.problems ?? []) this.#emit({ ev: "notice", msg: `The connected program "${p.server}" could not be used: ${p.reason}` });
    }, () => undefined));
  }

  async idle(): Promise<void> { await this.#running; }

  /** Aborted when the engine is closed: what is still being connected (see `connectMcp`) is stopped then. */
  get closing(): AbortSignal { return this.#closing.signal; }

  /** Closes the engine and waits until what it started has exited, so the folder it worked in can be removed. */
  async shutdown(): Promise<void> {
    this.close();
    await this.#jobs.stopped();
  }

  close(): void {
    this.#closing.abort();
    this.#cancel();
    this.#jobs.close();
    forget(this.#shell);
    for (const dispose of this.#disposers.splice(0)) attempt(dispose);
    if (this.#heartbeat) clearInterval(this.#heartbeat);
  }

  #prompt(cmd: PromptCommand): void {
    if (cmd.qid && !this.#qids.isNew(cmd.qid)) return;
    if (cmd.mode && this.#kind === "agent") this.#mode = cmd.mode;
    if (cmd.effort) this.#effort = cmd.effort;
    const item: Queued = { text: cmd.text, images: cmd.images ?? [], ...(cmd.qid ? { qid: cmd.qid } : {}) };
    this.#attach(item, cmd);
    if (this.#busy) { this.#queue.push(item); if (item.qid) this.#emit({ ev: "queued", qid: item.qid, text: item.text, ...(item.images.length ? { images: item.images.length } : {}), ...(item.files?.length ? { files: item.files } : {}) }); return; }
    this.#busy = true;
    this.#running = this.#turn(item);
  }

  /** Where this session keeps what is attached to it. A conversation held to its own folder can read nothing outside it, so there it is a folder inside. */
  #attachmentDir(): string {
    return isConfined(this.#kind) ? join(this.#o.cwd, "attachments") : join(this.#o.attachments ?? join(tmpdir(), "navvied-attachments"), this.sessionId);
  }

  /** Saves the files of a prompt and works out what the model is told about them. Pictures a blind model cannot use are left out. */
  #attach(item: Queued, cmd: PromptCommand): void {
    let blind = false;
    const told: string[] = [];
    if (this.#vision === false && item.images.length) {
      told.push(`${item.images.length === 1 ? "A picture was" : `${item.images.length} pictures were`} attached but not shown to you: this model cannot see pictures.`);
      item.images = [];
      blind = true;
    }
    if (cmd.files?.length && !this.#takesFiles()) {
      item.files = cmd.files.map((f) => ({ name: f.name, kind: "refused" as const, note: REFUSED.noFiles }));
      told.push(cmd.files.map((f) => `not attached: ${f.name}. ${REFUSED.noFiles}`).join("\n\n"));
      this.#emit({ ev: "notice", msg: REFUSED.noFiles });
    } else if (cmd.files?.length) {
      const r = receive(cmd.files, { dir: this.#attachmentDir(), ...(this.#vision !== undefined ? { vision: this.#vision } : {}), budget: outputBudget(this.#window), readsPdf: this.#provider.readsPdf === true });
      if (r.text) told.push(this.#unseen(r.text));
      if (r.parts.length) item.parts = r.parts;
      item.files = r.notes;
      blind ||= r.blind;
    }
    if (told.length) item.attached = told.join("\n\n");
    if (blind) this.#emit({ ev: "notice", msg: BLIND });
  }

  /** Whether the model in use takes files: a model list that says `files: false` for it closes attachments (a hosted model an administrator closed). */
  #takesFiles(): boolean {
    const info = this.#o.switcher ? this.#o.switcher.models.find((m) => m.id === (this.#wantModel ?? this.#model)) : this.#o.model;
    return info?.files !== false;
  }

  /** The model in use does not take an effort setting after all: Auto from now on, and the person is told in one sentence. */
  #dropEffort(): void {
    this.#noEffort.add(this.#model ?? "");
    this.#effort = undefined;
    this.#efforts = undefined;
    this.#announce();
    this.#emit({ ev: "notice", msg: "This model does not take an effort setting, so it runs on Auto." });
  }

  /** A service turned a picture down that the engine did not know it could not read: the pictures leave the conversation and the model is known as blind from now on. */
  #learnBlind(): boolean {
    let found = false;
    for (const m of this.#messages) {
      if (typeof m.content === "string" || !m.content?.some((p) => p.type === "image")) continue;
      found = true;
      m.content = m.content.map((p): Part => (p.type === "image" ? { type: "text", text: "[a picture was attached here; this model cannot see pictures]" } : p));
    }
    if (found) { this.#vision = false; this.#announce(); }
    return found;
  }

  /** Messages that were waiting and will not run: every window is told, so none stays on the screen as waiting for ever. */
  #dropQueue(): void {
    const qids = this.#queue.flatMap((q) => (q.qid ? [q.qid] : []));
    this.#queue.length = 0;
    if (qids.length) this.#emit({ ev: "dropped", qids });
  }

  #cancel(): void {
    if (!this.#busy) return;
    this.#cancelled = true;
    this.#dropQueue();
    this.#abort.abort();
    this.#approvals.denyAll();
  }

  /** What this engine can do right now. Sent at the start and again whenever the model or the effort changes. */
  #announce(): void {
    const sw = this.#o.switcher;
    this.#emit({
      ev: "caps", steer: true, ...(this.#kind === "chat" ? { kind: "chat" as const, modes: [] } : { modes: ["ask", "edits", "plan", "auto", "bypass"] as PermMode[], defaultMode: "auto" as const }), compact: true,
      ...(this.#o.checkpoints && this.#kind === "agent" ? { checkpoints: true } : {}),
      ...(sw ? { models: sw.models.map((m) => ({ ...m, current: m.id === (this.#wantModel ?? this.#model) })) } : this.#o.model ? { models: [{ ...this.#o.model, current: true }] } : {}),
      ...(this.#efforts?.length ? { efforts: this.#efforts } : {}),
      ...(this.#effort ? { effort: this.#effort } : {}),
      ...(this.#vision !== undefined ? { vision: this.#vision } : {}),
    });
  }

  /**
   * Switch models. The choice is made at once (every window is shown the new model as the current one) and reaches the next message:
   * a turn that is being answered finishes with the model it started with, as in every other app. A conversation too long for the new
   * model is summarised first, by the model that can still read it.
   */
  #useModel(id: string): void {
    const sw = this.#o.switcher;
    if (!sw) { this.#emit({ ev: "error", msg: "This engine has only one model." }); return; }
    if (id === (this.#wantModel ?? this.#model)) return;
    const check = sw.use(id);
    if ("error" in check) { this.#emit({ ev: "error", msg: check.error }); return; }
    if (this.#busy) { this.#wantModel = id; this.#announce(); return; }
    this.#wantModel = id;
    this.#busy = true;
    this.#abort = new AbortController();
    this.#running = (async () => {
      const fits = await this.#applyWantedModel();
      this.#lastContext = estimateTokens(this.#messages);
      this.#busy = false;
      this.#announce();
      this.#emit({ ev: "usage", ctx: this.#lastContext, win: this.#window, out: 0 });
      this.#emit({ ev: "done", stop: fits ? "end_turn" : "error" });
    })();
  }

  /** Puts the model that was chosen in use (between two turns), summarising first when the conversation is too long for it. False when it cannot be done. */
  async #applyWantedModel(): Promise<boolean> {
    const id = this.#wantModel;
    const sw = this.#o.switcher;
    if (!id || !sw) return true;
    this.#wantModel = undefined;
    if (id === this.#model) return true;
    const next = sw.use(id);
    if ("error" in next) { this.#emit({ ev: "error", msg: next.error }); return false; }
    let fits = !shouldCompact(estimateTokens(this.#messages), next.window);
    for (const keep of [KEEP_TAIL, 2]) {
      if (fits) break;
      await this.#compact(false, keep);
      fits = !shouldCompact(estimateTokens(this.#messages), next.window);
    }
    if (fits) {
      this.#provider = next.provider;
      this.#window = next.window;
      if (next.persona !== undefined) this.#persona = next.persona;
      if (next.reference !== undefined) this.#reference = next.reference;
      this.#model = id;
      this.#efforts = this.#noEffort.has(id) ? undefined : next.efforts;
      this.#vision = next.vision;
      if (this.#effort && !next.efforts?.includes(this.#effort)) this.#effort = undefined;
    } else this.#emit({ ev: "error", msg: "The last messages are longer than that model can read, so nothing was changed. Choose a model with more room." });
    this.#announce();
    return fits;
  }

  #setEffort(level: Effort | "auto"): void {
    if (level === "auto") { this.#effort = undefined; this.#announce(); return; }
    if (!this.#efforts?.includes(level)) { this.#emit({ ev: "error", msg: this.#efforts?.length ? `This model does not have the effort level ${level}.` : "This model has no effort setting." }); return; }
    this.#effort = level;
    this.#announce();
  }

  #compactCommand(): void {
    if (this.#busy) { this.#emit({ ev: "error", msg: "Wait for the current turn to finish, then compact." }); return; }
    this.#busy = true;
    this.#abort = new AbortController();
    this.#running = this.#compact(true).then((ok) => { this.#busy = false; this.#emit({ ev: "done", stop: ok ? "compacted" : "error" }); });
  }

  #listCheckpoints(): void {
    const store = this.#o.checkpoints;
    if (!store) { this.#emit({ ev: "error", msg: "Checkpoints are not enabled for this session." }); return; }
    this.#emit({ ev: "checkpoints", items: store.info() });
  }

  #restore(id: string, preview: boolean): void {
    const store = this.#o.checkpoints;
    if (!store) { this.#emit({ ev: "error", msg: "Checkpoints are not enabled for this session." }); return; }
    if (this.#busy) { this.#emit({ ev: "error", msg: "Wait for the current turn to finish before restoring." }); return; }
    if (preview) {
      const changes = store.preview(id);
      if (changes) this.#emit({ ev: "restore", id, preview: true, changes });
      else this.#emit({ ev: "error", msg: "That checkpoint was not found." });
      return;
    }
    const done = store.restore(id);
    if (!done) { this.#emit({ ev: "error", msg: "That checkpoint was not found." }); return; }
    for (const msg of done.errors) this.#emit({ ev: "error", msg });
    this.#emit({ ev: "restore", id, preview: false, changes: done.changes, ...(done.undoId ? { undoId: done.undoId } : {}) });
  }

  #load(id: string): void {
    if (this.#busy) { this.#emit({ ev: "error", msg: "Wait for the current turn to finish before loading another session." }); return; }
    const saved = this.#o.store?.load(id);
    if (!saved) { this.#emit({ ev: "error", msg: "That session was not found." }); return; }
    this.#messages = saved;
    this.sessionId = id;
    this.#emit({ ev: "loaded", id, items: historyOf(saved) });
    this.#emit({ ev: "usage", ctx: estimateTokens(saved), win: this.#window, out: 0 });
  }

  async #turn(first: Queued): Promise<void> {
    this.#cancelled = false;
    this.#abort = new AbortController();
    let stop: StopReason = "end_turn";
    try {
      let next: Queued | undefined = first;
      while (next) {
        if (this.#o.hooks?.prompt) {
          const verdict = await this.#o.hooks.prompt({ text: next.text, first: !this.#hooked }, this.#abort.signal).catch(() => ({ notes: [] as string[], block: undefined, context: undefined }));
          this.#hooked = true;
          for (const note of verdict.notes) this.#emit({ ev: "notice", msg: note });
          if (verdict.block) { this.#emit({ ev: "error", msg: `Blocked by a hook: ${verdict.block}` }); next = this.#queue.shift(); continue; }
          if (verdict.context) next = { ...next, text: `${next.text}\n\n[Added by the user's hook]\n${verdict.context}` };
        }
        await this.#applyWantedModel();
        this.#take(next, true);
        next = undefined;
        await this.#steps();
        this.#save();
        if (this.#cancelled) break;
        next = this.#queue.shift(); // sent too late to steer into the turn: it runs as its own
      }
      if (this.#cancelled) stop = "cancelled";
    } catch (e) {
      if (this.#cancelled) stop = "cancelled";
      else {
        const message = e instanceof Error ? e.message : String(e);
        this.#emit({ ev: "error", msg: REFUSES_PICTURES.test(message) && this.#learnBlind() ? BLIND : message });
        stop = "error";
      }
      this.#save();
    } finally {
      // A model chosen during this turn takes effect now, so the next message finds it in use.
      try { await this.#applyWantedModel(); } catch { /* the model stays as it was */ }
      this.#busy = false;
      this.#dropQueue();
      this.#emit({ ev: "done", stop });
      if (this.#o.hooks) void this.#o.hooks.stop({ reason: stop }).then((r) => { for (const note of r.notes) this.#emit({ ev: "notice", msg: note }); }).catch(() => undefined);
    }
  }

  #take(q: Queued, startsTurn = false): void {
    if (startsTurn) { this.#turnQid = q.qid; this.#turnTokens = { in: 0, out: 0, calls: 0 }; }
    if (startsTurn && this.#kind === "agent") this.#checkpoint = attempt(() => this.#o.checkpoints?.begin(q.text || "Message", [this.#o.cwd, ...this.#written]));
    if (q.qid) {
      this.#emit({ ev: "user", qid: q.qid, text: q.text, ...(q.images.length ? { images: q.images.length } : {}), ...(q.files?.length ? { files: q.files } : {}) });
      this.#emit({ ev: "taken", qid: q.qid });
    }
    this.#messages.push({ role: "user", content: asParts(q) });
  }

  /** What the person wrote last. */
  #lastUserText(): string {
    const m = [...this.#messages].reverse().find((x) => x.role === "user");
    return !m ? "" : typeof m.content === "string" ? m.content : (m.content ?? []).map((p) => (p.type === "text" ? p.text : "")).join(" ");
  }

  /** Everything the person has written so far, to decide which tools are worth offering. */
  #userText(): string {
    return this.#messages.filter((m) => m.role === "user").map((m) => (typeof m.content === "string" ? m.content : (m.content ?? []).map((p) => (p.type === "text" ? p.text : "")).join(" "))).join("\n");
  }

  async #steps(): Promise<void> {
    if (this.#loading.length) await Promise.all(this.#loading.splice(0));
    for (let step = 0; step < this.#o.maxSteps; step++) {
      if (this.#cancelled) return;
      if (shouldCompact(this.#lastContext, this.#window)) await this.#compact();
      if (this.#cancelled) return;

      const small = this.#window <= SMALL_WINDOW;
      const skills = attempt(() => this.#o.skills?.()) ?? [];
      const offeredNow = toolsFor(this.#mode, this.#tools, { small, userText: this.#userText(), jobs: this.#jobs.running, steps: step, chat: this.#kind === "chat", typable: this.#jobs.typable, skills: skills.length, recall: this.#o.recall !== undefined });
      // A tool the model has used stays offered. Of the others, the ones that are not offered are named in the prompt, and a call to one of
      // them is run, not refused: the words that bring a tool in (the web, a helper) are a guess about the request, and a guess can be wrong.
      const allowedNow = (t: Tool): boolean => this.#mode !== "plan" || t.readOnly;
      const tools = [...offeredNow, ...this.#tools.filter((t) => this.#called.has(t.name) && allowedNow(t) && !offeredNow.some((o) => o.name === t.name))];
      const news = this.#jobs.news();
      const finished = news.map((n) => `[${n.id} ${n.status === "done" || n.status === "failed" ? `finished: exit ${n.code}` : n.status}, ${(n.ms / 1000).toFixed(1)} s; BashOutput ${n.id} for the rest]`);
      const also = this.#tools.filter((t) => EXTRA.has(t.name) && allowedNow(t) && !tools.some((o) => o.name === t.name)).map((t) => t.name);
      const instructions = attempt(() => this.#o.instructions?.());
      const written = new TextToolCalls(Object.fromEntries(tools.map((t) => [t.name, t.parameters as { properties?: Record<string, { type?: string }> }])), `text${this.#messages.length}_`);
      let thinkingSince: number | undefined;
      const endThought = (): void => { if (thinkingSince !== undefined) { this.#emit({ ev: "thought_end", ms: Date.now() - thinkingSince }); thinkingSince = undefined; } };
      const said = (text: string): void => { if (text) { endThought(); this.#emit({ ev: "text", text }); } };
      const ask = (effort: Effort | undefined): Promise<ModelReply> => this.#provider.stream(
        {
          system: systemPrompt({ cwd: this.#o.cwd, platform: process.platform, date: (this.#o.now?.() ?? new Date()).toISOString().slice(0, 10), ...(this.#persona ? { persona: this.#persona } : {}), ...(this.#reference && asksAboutProgram(this.#lastUserText()) ? { reference: this.#reference } : {}), tools: tools.map((t) => t.name), ...(also.length ? { also } : {}), ...(finished.length ? { finished } : {}), ...(instructions ? { instructions } : {}), ...(skills.length ? { skills: skillsPrompt(skills, small)! } : {}), small, ...(this.#kind === "chat" ? { kind: "chat" as const, sandboxed: this.#o.sandboxed === true } : {}) }, this.#mode),
          messages: this.#messages,
          tools: tools.map(({ name, description, parameters }) => ({ name, description, parameters })),
          ...(effort ? { effort } : {}),
        },
        this.#abort.signal,
        {
          text: (text) => said(written.push(text)),
          thought: (text) => { thinkingSince ??= Date.now(); this.#emit({ ev: "thought", text }); },
          toolStarted: (id, name) => { endThought(); if (name !== PLAN_TOOL_NAME) this.#emit({ ev: "tool", id, name, status: "running", progress: 0 }); },
        },
      );
      // A server that does not know the effort field answers 400; the same request goes again without it, once, and the model is taken as one without an effort setting.
      let model: ModelReply;
      try { model = await ask(this.#effort); }
      catch (e) {
        if (!this.#effort || !refusesEffort(e)) throw e;
        this.#dropEffort();
        model = await ask(undefined);
      }

      // The model has the news only once its request has gone through: a request that failed does not use it up.
      this.#jobs.told(news.map((n) => n.id));
      said(written.finish());
      endThought();
      let reply: ModelReply = written.calls.length || written.shown !== model.content ? { ...model, content: written.shown, calls: [...model.calls, ...written.calls] } : model;
      // A model that cannot call tools may end its reply with `$ command` lines: they become one Bash call, when Bash is offered.
      const typed = !reply.calls.length && tools.some((t) => t.name === "Bash") ? dollarCommand(reply.content) : undefined;
      if (typed) reply = { ...reply, calls: [{ id: `text${this.#messages.length}_$`, name: "Bash", arguments: JSON.stringify({ command: typed }) }] };
      this.#lastContext = reply.usage?.prompt || estimateTokens(this.#messages);
      this.#turnTokens = { in: this.#turnTokens.in + this.#lastContext, out: this.#turnTokens.out + (reply.usage?.completion ?? 0), calls: this.#turnTokens.calls + 1 };
      this.#emit({ ev: "usage", ctx: this.#lastContext, win: this.#window, out: reply.usage?.completion ?? 0, turn: { ...this.#turnTokens } });
      if (reply.content || reply.calls.length) this.#messages.push({ role: "assistant", ...(reply.content ? { content: reply.content } : {}), ...(reply.calls.length ? { toolCalls: reply.calls } : {}) });

      if (!reply.calls.length) {
        if (this.#mode === "plan" && reply.content.trim()) this.#emit({ ev: "plan_proposal", id: `plan${this.#messages.length}` });
        return;
      }
      if (this.#mode === "plan" && this.#presentPlan(reply)) return;

      // Helpers (and other tools that only read) asked for in the same step run side by side; anything that may change something runs alone and in order, because it may need an answer from the person.
      const writesLater = (c: ToolCall): boolean => { // a helper allowed to change things must not run beside another one
        if (c.name !== AGENT_TOOL_NAME || (this.#mode !== "auto" && this.#mode !== "bypass")) return false;
        const named = parseLenient(c.arguments)?.agent;
        return typeof named === "string" && !!this.#o.agents?.find((d) => d.name === named)?.tools;
      };
      const together = reply.calls.length > 1 && reply.calls.every((c) => { const t = tools.find((x) => x.name === c.name); return t?.readOnly === true && !writesLater(c); });
      if (together) {
        const outputs = await Promise.all(reply.calls.map((call) => (this.#cancelled ? "[interrupted]" : this.#runTool(call, tools))));
        reply.calls.forEach((call, i) => this.#messages.push({ role: "tool", toolCallId: call.id, content: outputs[i]! }));
      } else {
        // The ones that wait for their turn are shown as waiting; any that never get it (the turn was stopped) are shown as skipped.
        for (const call of reply.calls.slice(1)) { const input = parseLenient(call.arguments); this.#emit({ ev: "tool", id: call.id, name: call.name, status: "running", queued: true, ...(input ? { input } : {}) }); }
        for (const call of reply.calls) {
          if (this.#cancelled) {
            this.#emit({ ev: "tool", id: call.id, name: call.name, status: "error", output: "[interrupted]", outcome: "skipped" });
            this.#messages.push({ role: "tool", toolCallId: call.id, content: "[interrupted]" });
            continue;
          }
          // The person sent a new message while this step waited its turn: it takes the place of the rest of the step.
          if (this.#queue.length) {
            this.#emit({ ev: "tool", id: call.id, name: call.name, status: "error", output: "[redirected]", outcome: "redirected" });
            this.#messages.push({ role: "tool", toolCallId: call.id, content: "[not run: the person sent a new message first]" });
            continue;
          }
          const output = await this.#runTool(call, tools);
          this.#messages.push({ role: "tool", toolCallId: call.id, content: output });
        }
      }
      // A message sent while the agent worked is folded in at this step boundary.
      const steer = this.#cancelled ? undefined : this.#queue.shift();
      if (steer) this.#take(steer);
    }
    this.#emit({ ev: "error", msg: `Stopped after ${this.#o.maxSteps} steps. Send a message to continue.` });
  }

  #presentPlan(reply: ModelReply): boolean {
    const exit = reply.calls.find((c) => c.name === PLAN_TOOL_NAME);
    if (!exit) return false;
    let plan = "";
    try { plan = String((JSON.parse(exit.arguments || "{}") as { plan?: unknown }).plan ?? "").trim(); } catch { /* the model sent broken arguments: show its text only */ }
    for (const c of reply.calls) this.#messages.push({ role: "tool", toolCallId: c.id, content: c === exit ? "Plan presented to the user for approval." : "Skipped: planning is finished." });
    this.#emit({ ev: "text", text: `${reply.content ? "\n\n" : ""}${plan}\n` });
    this.#emit({ ev: "plan_proposal", id: `plan${this.#messages.length}` });
    return true;
  }

  /**
   * A helper: a second engine with the same model and only the tools that read. It has no conversation of its own to start
   * from, no helpers of its own, and its steps are shown under the step that asked, so a long search stays out of the way.
   */
  async #delegate(parent: string, task: { description: string; prompt: string; agent?: string }, signal: AbortSignal): Promise<string> {
    let answer = "";
    let steps = 0;
    const def = task.agent ? this.#o.agents?.find((a) => a.name === task.agent) : undefined;
    // A helper may change things only when the person's own definition names the tools and the conversation is in Auto mode: in Ask mode nobody could answer its questions, and in Plan mode nothing may change.
    const writes = !!def?.tools && (this.#mode === "auto" || this.#mode === "bypass");
    const allowed = def?.tools ? this.#tools.filter((t) => def.tools!.includes(t.name) && t.name !== AGENT_TOOL_NAME && (writes || t.readOnly)) : this.#tools.filter((t) => t.readOnly && t.name !== AGENT_TOOL_NAME);
    const helper = new Engine({
      provider: this.#provider, cwd: this.#o.cwd, window: this.#window, heartbeatMs: 0, maxSteps: HELPER_STEPS,
      allowPrivateNetwork: this.#o.allowPrivateNetwork, noQuestions: true,
      tools: allowed,
      ...(this.#o.rules ? { rules: this.#o.rules } : {}),
      ...(this.#o.hooks ? { hooks: this.#o.hooks } : {}),
      ...(def ? { persona: `${this.#persona ? `${this.#persona}\n\n` : ""}You are the helper "${def.name}". ${def.prompt}` } : this.#persona ? { persona: this.#persona } : {}),
      ...(this.#o.instructions ? { instructions: this.#o.instructions } : {}),
      ...(this.#o.search ? { search: this.#o.search } : {}),
      ...(this.#o.webProxy ? { webProxy: this.#o.webProxy } : {}),
      ...(this.#o.skills ? { skills: this.#o.skills } : {}),
      emit: (e) => {
        if (e.ev === "text") answer += e.text;
        else if (e.ev === "tool") { if (e.status === "running" && e.input !== undefined) { answer = ""; steps++; } this.#emit({ ...e, id: `${parent}.${e.id}`, parent }); }
        else if (e.ev === "error") answer += `\n[the helper had a problem: ${e.msg}]`;
      },
    });
    const stop = (): void => helper.handle({ cmd: "cancel" });
    signal.addEventListener("abort", stop, { once: true });
    try {
      helper.handle({ cmd: "prompt", text: task.prompt, mode: "auto" });
      await helper.idle();
      return signal.aborted ? "[interrupted]" : answer.trim() || (steps ? "The helper looked around but wrote no answer." : "The helper wrote no answer.");
    } finally { signal.removeEventListener("abort", stop); helper.close(); }
  }

  /** The tool a call names: as offered, or by a name models invent for it, or one that exists and is not offered now (plan mode still allows only reading). */
  #toolFor(name: string, offered: Tool[]): Tool | undefined {
    const wanted = ALIASES[name.toLowerCase()] ?? name;
    const exact = offered.find((t) => t.name === wanted) ?? offered.find((t) => squash(t.name) === squash(wanted));
    if (exact) return exact;
    const known = this.#tools.find((t) => t.name === wanted) ?? this.#tools.find((t) => squash(t.name) === squash(wanted));
    return known && (this.#mode !== "plan" || known.readOnly) ? known : undefined;
  }

  async #runTool(call: ToolCall, offered: Tool[]): Promise<string> {
    let t0 = Date.now();
    const fail = (message: string, outcome?: ToolOutcome): string => { this.#emit({ ev: "tool", id: call.id, name: call.name, status: "error", output: message, ms: Date.now() - t0, ...(outcome ? { outcome } : {}) }); return message; };
    const tool = this.#toolFor(call.name, offered);
    if (tool) this.#called.add(tool.name);
    if (!tool) return fail(`Error: there is no tool "${call.name}". Use one of: ${offered.map((t) => t.name).join(", ")}${this.#mode === "plan" ? " (plan mode only allows reading)" : ""}.${offered.some((t) => t.name === "Bash") ? ' To run a command: Bash {"command": "ls -la"}' : ""}`);

    let args = parseLenient(call.arguments);
    if (!args) return fail(`Error: the arguments for ${call.name} must be a JSON object such as ${exampleArguments(tool.parameters)}. Send them again.`);
    const missing = (Array.isArray(tool.parameters.required) ? (tool.parameters.required as string[]) : []).filter((k) => args![k] === undefined);
    if (missing.length) return fail(`Error: ${tool.name} needs ${missing.join(", ")}: ${exampleArguments(tool.parameters)}. Send the call again with it.`);
    const bad = tool.name === "Edit" || tool.name === "Write" ? this.#vault.restore(CHANGED.map((k) => (typeof args![k] === "string" ? args![k] as string : "")).join("\n")).unknown : [];
    if (bad.length) return fail(`Error: ${bad[0]} is not a value you can write: it stands for a secret you were not shown, or one this conversation does not know any more. To keep a value as it is, write the [hidden:N] mark that Read gave for it; otherwise ask the person for the value.`);
    this.#emit({ ev: "tool", id: call.id, name: tool.name, status: "running", input: this.#shown(args) });

    // What may never be done is stopped in every mode, before anything else is asked.
    const forbidden = hardBlock(tool.name, args, this.#o.cwd);
    if (forbidden) return fail(`Blocked: ${forbidden}. navvied never does this.`, "blocked");
    const verdict = this.#o.rules?.check(tool.name, args) ?? { kind: "none" as const };
    if (verdict.kind === "deny") return fail(`Blocked by the permission rule ${verdict.rule}. Do not try again; tell the user what you wanted to do.`, "blocked");
    // What cannot be undone is asked about in every mode but Bypass, and a rule that allows "git" does not allow it: what is allowed is a kind of thing.
    const risk = tool.readOnly || this.#mode === "plan" || this.#mode === "bypass" ? undefined : riskOf(tool.name, args, this.#o.cwd);
    const riskAsked = risk !== undefined && !this.#allowed.has(risk.key);
    const mustAsk = verdict.kind === "ask" ? this.#mode !== "plan" : riskAsked || (needsApproval(this.#mode, tool, args) && verdict.kind !== "allow");
    if (mustAsk) {
      const scope = riskAsked ? { key: risk!.key, phrase: risk!.phrase } : approvalScope(tool.name, args, this.#o.cwd);
      if (this.#o.noQuestions) return fail(`Blocked: this needs the person's say-so${risk ? ` (${risk.reason})` : ""}, and a helper cannot ask. Do not try again; say what you wanted to do.`, "blocked");
      if (verdict.kind === "ask" || riskAsked || !(scope.keys ?? [scope.key]).every((k) => this.#allowed.has(k))) {
        const { id, answer } = this.#approvals.open();
        const change = approvalChange(tool.name, this.#shown(args));
        // A command can be changed by the person before it is allowed.
        const editable = tool.name === "Bash" && typeof args.command === "string" ? this.#vault.hide(args.command).text : undefined;
        this.#emit({ ev: "approval", id, title: this.#vault.hide(attempt(() => tool.title(args!)) ?? `Run ${tool.name}`).text, options: approvalOptions(scope.phrase, editable), tool: call.id, ...(change ? { change } : {}), ...(riskAsked ? { risk: risk!.reason } : {}) });
        const given = await answer;
        if (given.optionId === ALLOW_ALWAYS) for (const k of scope.keys ?? [scope.key]) this.#allowed.add(k);
        else if (given.optionId === EDIT && editable !== undefined && given.input?.trim()) {
          // What the person typed is held to the same limits as anything else, and shown as the step's new input.
          const typed = this.#vault.restore(given.input.trim());
          if (typed.unknown.length) return fail(`Not run: ${typed.unknown.join(", ")} stands for a secret that is not known any more. Read the file again for its mark, or give the value.`, "blocked");
          args = { ...args, command: typed.text };
          const again = hardBlock(tool.name, args, this.#o.cwd);
          if (again) return fail(`Blocked: ${again}. navvied never does this.`, "blocked");
          const rule = this.#o.rules?.check(tool.name, args);
          if (rule?.kind === "deny") return fail(`Blocked by the permission rule ${rule.rule}.`, "blocked");
          this.#emit({ ev: "tool", id: call.id, name: tool.name, status: "running", input: this.#shown(args) });
        } else if (given.optionId !== ALLOW && given.optionId !== EDIT) return fail("The user denied this action.", "denied");
      }
    }
    if (this.#o.hooks) {
      const before = await this.#o.hooks.pre({ tool: tool.name, input: args }, this.#abort.signal).catch(() => ({ notes: [] as string[], block: undefined }));
      for (const note of before.notes) this.#emit({ ev: "notice", msg: note });
      if (before.block) return fail(`Blocked by a hook: ${before.block}`, "blocked");
    }
    if (this.#abort.signal.aborted) return fail("[interrupted]", "stopped");
    if (!tool.readOnly) this.#beforeWrite(args);
    // How long it took is how long it ran, not how long the person took to answer.
    t0 = Date.now();

    // What a command prints is passed on a little at a time; how it ended is reported by the tool.
    let pending = "", sent = 0, timer: ReturnType<typeof setTimeout> | undefined;
    const flush = (): void => { timer = undefined; if (pending) { this.#emit({ ev: "tool", id: call.id, name: tool.name, status: "running", live: pending }); pending = ""; } };
    // What a running command prints is made safe as it arrives, before it reaches an event.
    const safe = new Redactor();
    const live = (raw: string): void => { const chunk = safe.push(raw); if (!chunk || sent > LIVE_MOST) return; sent += chunk.length; pending += chunk; timer ??= setTimeout(flush, LIVE_EVERY_MS); };
    let meta: { code?: number | null; truncated?: boolean; timedOut?: boolean; background?: boolean } = {};
    let output: string;
    try {
      output = await tool.run(this.#restored(tool.name, args), { cwd: this.#o.cwd, ...(isConfined(this.#kind) ? { root: this.#o.cwd } : {}), signal: this.#abort.signal, emit: (e) => this.#emit(e.ev === "plan" ? { ...e, ...(this.#turnQid ? { qid: this.#turnQid } : {}), tool: call.id } : e), live, report: (m) => { meta = { ...meta, ...m }; }, allowPrivateNetwork: this.#o.allowPrivateNetwork, window: this.#window, shell: this.#shell, jobs: this.#jobs, ...(this.#o.backend ? { backend: this.#o.backend } : {}), ...(this.#o.recall ? { recall: this.#o.recall } : {}), ...(this.#o.search ? { search: this.#o.search } : {}), ...(this.#o.webProxy ? { webProxy: this.#o.webProxy } : {}), ...(this.#o.skills ? { skills: this.#o.skills } : {}), ...(this.#o.memory ? { memory: this.#o.memory } : {}), helper: (task, signal) => this.#delegate(call.id, task, signal) });
    } catch (e) { output = `Error: ${e instanceof Error ? e.message : String(e)}`; }
    clearTimeout(timer);
    flush();
    // Whatever a tool gave, no more than the window can spare reaches the model.
    if (tool.name === "Read" || tool.name === "Grep") output = this.#unseen(output);
    output = withinBudget(tool.name, output, this.#window);
    const stopped = this.#abort.signal.aborted || output.endsWith("[interrupted]");
    const outcome: ToolOutcome | undefined = meta.timedOut ? "timeout" : stopped ? "stopped" : meta.background ? "background" : undefined;
    const failed = output.startsWith("Error:") || outcome === "timeout" || outcome === "stopped";
    this.#emit({ ev: "tool", id: call.id, name: tool.name, status: failed ? "error" : "done", output, ms: Date.now() - t0, ...(meta.code !== undefined ? { code: meta.code } : {}), ...(meta.truncated ? { truncated: true as const } : {}), ...(outcome ? { outcome } : {}) });
    if (this.#o.hooks) for (const note of (await this.#o.hooks.post({ tool: tool.name, input: args, output }, this.#abort.signal).catch(() => ({ notes: [] as string[] }))).notes) this.#emit({ ev: "notice", msg: note });
    return output;
  }

  async #compact(manual = false, keep: number = KEEP_TAIL): Promise<boolean> {
    this.#emit({ ev: "phase", name: "compacting" });
    if (this.#o.hooks?.compact) for (const note of (await this.#o.hooks.compact({ manual }, this.#abort.signal).catch(() => ({ notes: [] as string[] }))).notes) this.#emit({ ev: "notice", msg: note });
    try {
      const next = await compactMessages(this.#messages, this.#provider, this.#abort.signal, keep);
      if (!next) { if (manual) this.#emit({ ev: "error", msg: "Nothing to compact yet — the conversation is still short." }); return false; }
      this.#messages = next;
      this.#lastContext = estimateTokens(next);
      this.#emit({ ev: "usage", ctx: this.#lastContext, win: this.#window, out: 0 });
      this.#save();
      return true;
    } catch (e) {
      this.#emit({ ev: "error", msg: `Couldn't compact: ${e instanceof Error ? e.message : String(e)}` });
      return false;
    } finally { this.#emit({ ev: "phase", name: "" }); }
  }

  #beforeWrite(args: Record<string, unknown>): void {
    const target = typeof args.file_path === "string" ? resolve(this.#o.cwd, args.file_path) : undefined;
    if (!target) return;
    this.#written.add(target);
    if (this.#checkpoint) attempt(() => this.#o.checkpoints?.add(this.#checkpoint!, target));
  }

  #save(): void { try { this.#o.store?.save(this.sessionId, this.#messages); } catch { /* a full disk must not kill the turn */ } }
  /** The arguments of a call as a window or a log may show them: every secret in them is a mark. */
  #shown(args: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(Object.entries(args).map(([k, v]) => [k, typeof v === "string" ? this.#vault.hide(v).text : v]));
  }

  /** The arguments of an Edit or a Write with the marks put back as the values they stand for: only the file ever gets them. */
  #restored(tool: string, args: Record<string, unknown>): Record<string, unknown> {
    if (tool !== "Edit" && tool !== "Write") return args;
    return Object.fromEntries(Object.entries(args).map(([k, v]) => [k, CHANGED.includes(k) && typeof v === "string" ? this.#vault.restore(v).text : v]));
  }

  /** What the model is given of a file or a search: the secrets in it are marks, and it is told once what the marks are. */
  #unseen(text: string): string {
    const h = this.#vault.hide(text);
    return h.count ? `${h.text}\n[${h.count} secret ${h.count === 1 ? "value is" : "values are"} hidden as [hidden:N] marks; write a mark in Edit or Write to keep that value as it is]` : h.text;
  }

  #emit(event: EngineEvent): void { attempt(() => this.#o.emit(event)); }
}
