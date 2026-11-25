/**
 * The engine: one conversation, one agent loop. It receives protocol commands and emits protocol events; everything it needs
 * from the outside (model provider, session store, tools, clock) is passed in, so a whole run can be tested against a script.
 */
import { RetryProvider, type RetryOptions } from "./providers/retry.ts";
import { historyOf } from "./store.ts";
import { join, resolve } from "node:path";
import { REFUSED, RecentIds, type ApprovalOption, type Command, type Effort, type EngineEvent, type FileNote, type ModelInfo, type PermMode, type PlanEntry, type QuestionItem, type PromptCommand, type SessionKind, type StopReason, type ToolOutcome, type TurnTokens } from "@navvied/protocol";
import { ALLOW, ALLOW_ALWAYS, ApprovalBroker, EDIT, approvalOptions } from "./approvals.ts";
import type { Checkpoint, Checkpoints } from "./checkpoints.ts";
import type { AgentEngine } from "./contract.ts";
import { KEEP_TAIL, compactMessages, estimateTokens, shouldCompact } from "./context.ts";
import { parseLenient } from "./lenient-json.ts";
import type { Hooks } from "./hooks.ts";
import type { MemoryPaths } from "./memory.ts";
import { approvalChange } from "./approval-change.ts";
import { Jobs } from "./jobs.ts";
import { DEFAULT_ASK_WAIT_S, MOST_QUESTIONS_PER_TURN, NOBODY_ANSWERS, QuestionBroker, answersText } from "./questions.ts";
import { isolate } from "./worktree.ts";
import { jobLines, wakeText } from "./job-note.ts";
import { childEnv, type EnvPolicy } from "./child-env.ts";
import { Redactor, registerSecrets } from "./redact.ts";
import { forget, type ShellState } from "./tools/shell-state.ts";
import { modelSkills, skillsPrompt, type SkillInfo } from "./skills.ts";
import type { SkillBook } from "./skill-book.ts";
import { messagesAsText, toolsInPrompt } from "./text-tools.ts";
import { TextToolCalls, dollarCommand } from "./text-tool-calls.ts";
import type { Backend } from "./backend.ts";
import { toolsFor } from "./permissions.ts";
import { judge } from "./judge.ts";
import { isConfined, profileTools } from "./profiles.ts";
import { hardBlock, type Rules } from "./rules.ts";
import { asksAboutProgram, systemPrompt } from "./prompt.ts";
import { PLAN_TOOL_NAME, defaultTools } from "./tools/index.ts";
import { changedPaths, FILE_WRITERS, mapText, textOf } from "./tools/changed.ts";
import { FileState } from "./tools/file-state.ts";
import { SPILL_DIR, outputBudget, withinBudget } from "./tools/util.ts";
import { receive } from "./attachments.ts";
import { Vault } from "./redact.ts";
import { WEB_ALIASES } from "./tools/web-names.ts";
import { PageCache } from "./tools/web-cache.ts";
import { tmpdir } from "node:os";
import { AGENT_TOOL_NAME, agentTool } from "./tools/agent.ts";
import { ASK_TOOL_NAME } from "./tools/ask.ts";
import { STALE_AFTER_STEPS, TODO_TOOL_NAME, parseTodos, staleNote, unfinished } from "./tools/todo.ts";
import type { AgentDef } from "./agents.ts";
import type { Message, ModelReply, Part, Provider, Recall, SessionStore, Tool, ToolCall, WebProxy } from "./types.ts";

/** What a helper needs the person to decide: the fields of an `approval` event, before the engine gives it an id. */
type ApprovalAsk = { title: string; options: ApprovalOption[]; tool: string; change?: Extract<EngineEvent, { ev: "approval" }>["change"]; risk?: string };

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
  /** How a call to the model that failed is made again (the number of tries, and for a test how the waiting is done). */
  retry?: RetryOptions;
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
  /** Whether the model is offered `apply_patch`: `auto` (default) when its window is not small, `on` always, `off` never. */
  applyPatch?: "auto" | "on" | "off";
  /** Where Bash runs its commands: a container or another machine instead of this computer. */
  backend?: Backend;
  /** Nobody can be asked (a helper): what would be asked about is refused instead, unless `escalate` hands it to someone who can answer. */
  noQuestions?: boolean;
  /** A helper's way to the person: the question is asked by the engine that started the helper. */
  escalate?: (question: ApprovalAsk) => Promise<{ optionId: string; input?: string }>;
  /** Whether a person is looking at this conversation right now (a window or a terminal is attached). Without it nobody is: a question is not waited for. */
  attended?: () => boolean;
  /** How long a question waits for the person, in milliseconds (default: ten minutes with a window attached, no wait without). */
  askWaitMs?: number;
  /** What helpers may use: how many work at once, how many steps and how many seconds each may take. */
  helperLimits?: { parallel?: number; steps?: number; seconds?: number };
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
  /** What a command may not inherit from this program's environment (see child-env.ts). */
  env?: EnvPolicy;
  /** Where background commands keep their output and the record a restart finds them by; without it nothing is taken back after a restart. */
  jobsDir?: string;
  /** A command that ended, or printed what it was asked to watch for, starts a turn by itself when the conversation is idle (the host that shows the conversation says so). */
  wake?: boolean;
  /** The least time between two such turns, in ms (default 2000). */
  wakeGapMs?: number;
  /** How the agent makes and changes skills (the SkillManage tool), and how a change is handled: it waits for the person (`ask`) or is made and can be undone (`auto`). */
  skillBook?: SkillBook;
  skillApproval?: () => "ask" | "auto";
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
const ALIASES: Record<string, string> = { ...WEB_ALIASES, bash: "Bash", shell: "Bash", terminal: "Bash", run: "Bash", execute_bash: "Bash", run_command: "Bash", exec: "Bash", sh: "Bash" };
const squash = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Tools that are named in the prompt, without their definitions, when the request has not brought them in. */
const EXTRA = new Set(["WebSearch", "WebFetch", "Agent", "Remember", "Recall", "SkillManage", "TodoWrite"]);

/** Tools whose results are text somebody else wrote. */
const WEB_TOOLS = new Set(["WebSearch", "WebFetch", "Browser"]);

/** A context window this small, or smaller, marks a model that needs a lighter touch. */
export const SMALL_WINDOW = 40_000;
/** How many turns the news of commands may start before the person writes again, and the least time between two. */
const MOST_WAKES = 12;
const WAKE_GAP_MS = 2000;
/** The steps a helper may take before it must answer. */
/** How often what a running command printed is sent on, and the most of it that is. */
const LIVE_EVERY_MS = 150;
const LIVE_MOST = 200_000;
const HELPER_STEPS = 25;
const HELPER_PARALLEL = 4;
const HELPER_SECONDS = 600;
/** What every helper is told about its answer: the one who asked reads only that. */
const HELPER_RULE = "Answer with what you found, with file paths and line numbers. No preamble and no list of what you did.";
/** Tools a helper never has: it cannot ask the person, keep a list of its own or start helpers. */
const NOT_FOR_HELPERS = new Set([AGENT_TOOL_NAME, ASK_TOOL_NAME, TODO_TOOL_NAME]);

const asParts = (q: Queued): string | Part[] => {
  const text = [q.text, q.attached].filter(Boolean).join("\n\n");
  const rest: Part[] = [...q.images.map((i) => ({ type: "image" as const, mime: i.mime, data: i.data })), ...(q.parts ?? [])];
  return rest.length ? [...(text ? [{ type: "text" as const, text }] : []), ...rest] : text;
};

/** The server turned the request down because of the effort field: a 400 that names it, or a parameter it does not know. */
const refusesEffort = (e: unknown): boolean => (e as { status?: number } | undefined)?.status === 400 && /effort|reasoning|unknown (parameter|field|argument|name)|unrecognized (parameter|field|request argument)|unsupported (parameter|field)|extra inputs|additional properties|not permitted/i.test(e instanceof Error ? e.message : "");

/** The server says the model has no tool calling at all (a 400 that names it): the request goes again without tools, and so does every later one of that model. */
const refusesTools = (e: unknown): boolean => (e as { status?: number } | undefined)?.status === 400 && /does not support tools|tools? (is|are)? ?not supported|no tool (support|calling)/i.test(e instanceof Error ? e.message : "");

/** The words a person is shown when the model cannot see pictures. */
const BLIND = "This model cannot see pictures, so they were not sent.";
const REFUSES_PICTURES = /image|picture|vision|multimodal|multi-modal|modalit/i;

/** A model is called again by itself when that is worth it: one that does not already do so is put inside the one loop that does. */
const retrying = (p: Provider, o?: RetryOptions): Provider => (p.retries ? p : new RetryProvider(p, o));

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
  readonly #questions = new QuestionBroker();
  /** Questions nobody answered in time, by id: an answer that comes later is told to the model as a message. */
  readonly #expired = new Map<string, QuestionItem[]>();
  /** Questions asked in the turn that is running. */
  #asked = 0;
  /** The task list the model keeps, and the model's steps since it last touched it. */
  #todos: PlanEntry[] = [];
  #sinceTodo = 0;
  /** Helpers at work: how many hold a place, who waits for one, and the ones started in the background (to stop them). */
  #helpersBusy = 0;
  readonly #helperQueue: (() => void)[] = [];
  readonly #background = new Map<string, AbortController>();
  #nextHelper = 1;
  #relay: Promise<unknown> = Promise.resolve();
  readonly #queue: Queued[] = [];
  /** A model chosen while a turn was being answered: it is used from the next one. */
  #wantModel: string | undefined;
  #messages: Message[] = [];
  #mode: PermMode = "auto";
  /** Text from the web has come into this turn: what the agent saves from here on is marked as such. */
  #webSeen = false;
  get #kind(): SessionKind { return this.#o.kind ?? "agent"; }
  #effort: Effort | undefined;
  #provider: Provider;
  #window: number;
  #vision: boolean | undefined;
  /** The files this conversation has read or written, which the tools that change files check. */
  readonly #files = new FileState();
  /** Pictures a tool handed over this step: they reach the model in a message after the results. */
  #pictures: Part[] = [];
  #persona: string | undefined;
  #reference: string | undefined;
  #model: string | undefined;
  #efforts: Effort[] | undefined;
  /** Models that turned the effort field down in this session: none is offered for them again. */
  readonly #noEffort = new Set<string>();
  readonly #noTools = new Set<string>();
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
  readonly #jobs: Jobs;
  /** Turns started by the news of a command since the person last wrote, and when the last began. */
  #wakes = 0;
  #wokeAt = -Infinity;
  #wakeTimer: ReturnType<typeof setTimeout> | undefined;
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
    this.#provider = retrying(opts.provider, opts.retry);
    this.#window = opts.window;
    this.#vision = opts.vision;
    registerSecrets(opts.secrets ?? []);
    this.#persona = opts.persona;
    this.#reference = opts.reference;
    this.#model = opts.switcher?.current;
    this.#efforts = opts.switcher?.efforts ?? opts.efforts;
    this.#tools = profileTools(opts.kind ?? "agent", opts.tools ?? defaultTools({ applyPatch: opts.applyPatch }), { sandboxed: opts.sandboxed === true }).map((t) => (t.name === AGENT_TOOL_NAME && opts.agents?.length ? agentTool(opts.agents) : t));
    this.sessionId = opts.sessionId ?? crypto.randomUUID();
    this.#jobs = new Jobs((e) => this.#emit(e), Date.now, { session: this.sessionId, ...(opts.jobsDir ? { dir: opts.jobsDir } : {}), env: () => childEnv(process.env, opts.env), onNews: () => this.#wakeNow(), ...(opts.wake ? { wake: true } : {}) });
    if (opts.sessionId && opts.store) { this.#messages = opts.store.load(opts.sessionId) ?? []; this.#restoreTodos(); }
    const every = opts.heartbeatMs ?? 15_000;
    if (every > 0) {
      this.#heartbeat = setInterval(() => { if (this.#busy) this.#emit({ ev: "alive" }); }, every);
      this.#heartbeat.unref?.();
    }
    this.#emit({ ev: "session", id: this.sessionId });
    this.#jobs.recover();
    this.#announce();
    if (this.#messages.length) this.#emit({ ev: "usage", ctx: estimateTokens(this.#messages), win: this.#window, out: 0 });
  }

  /** Feed one command. Returns at once; work continues in the background (see {@link idle}). */
  handle(cmd: Command): void {
    switch (cmd.cmd) {
      case "prompt": return this.#prompt(cmd);
      case "cancel": return this.#cancel();
      case "job.stop": if (!this.#jobs.stop(cmd.id)) this.#background.get(cmd.id)?.abort(); return;
      case "approve": this.#approvals.answer(cmd.id, cmd.optionId, cmd.input); return;
      case "answer": return this.#answered(cmd.id, cmd.answers);
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
    clearTimeout(this.#wakeTimer);
    this.#cancel();
    for (const c of this.#background.values()) c.abort();
    this.#jobs.close();
    forget(this.#shell);
    for (const dispose of this.#disposers.splice(0)) attempt(dispose);
    if (this.#heartbeat) clearInterval(this.#heartbeat);
  }

  #prompt(cmd: PromptCommand): void {
    if (cmd.qid && !this.#qids.isNew(cmd.qid)) return;
    this.#wakes = 0;
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

  /**
   * The one way work that is not a turn (a model switch, a manual compact) holds the engine: busy for as long as `work` takes, then
   * the end of busy, which is the only place that looks at the queue. A prompt sent while it ran was only ever queued, never taken into
   * a turn (`#prompt` queues anything sent while `#busy`), so it runs now as its own turn instead of waiting for some later prompt to
   * notice it. A failing `work` is told and ends the same way: busy never outlives it. Only when nothing arrived does `settled` run and
   * `done` say the engine is idle again. `#running` ends up being the turn that was started, so `idle()` still means what it says.
   *
   * A turn ends differently on purpose (see `#turn`): there, stop is the person's answer to what was waiting, so a cancelled or failed
   * turn drops its queue and tells every window; here nothing was stopped, so nothing waiting is dropped.
   */
  #exclusive(work: () => Promise<StopReason>, settled?: () => void): void {
    this.#busy = true;
    this.#abort = new AbortController();
    this.#running = (async () => {
      let stop: StopReason = "error";
      try { stop = await work(); } catch (e) { this.#emit({ ev: "error", msg: e instanceof Error ? e.message : String(e) }); }
      const next = this.#queue.shift();
      if (next) { this.#running = this.#turn(next); await this.#running; return; }
      this.#busy = false;
      settled?.();
      this.#emit({ ev: "done", stop });
      this.#wakeNow();
    })();
  }

  /** Messages that were waiting and will not run (the turn was cancelled or failed): every window is told, so none stays on the screen as waiting for ever. */
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
    this.#questions.closeAll();
  }

  /** What this engine can do right now. Sent at the start and again whenever the model or the effort changes. */
  #announce(): void {
    const sw = this.#o.switcher;
    this.#emit({
      ev: "caps", steer: true, ...(this.#kind === "agent" ? { questions: true as const } : {}), ...(this.#kind === "chat" ? { kind: "chat" as const, modes: [] } : { modes: ["ask", "edits", "plan", "auto", "bypass"] as PermMode[], defaultMode: "auto" as const }), compact: true,
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
    this.#exclusive(async () => {
      const fits = await this.#applyWantedModel();
      this.#lastContext = estimateTokens(this.#messages);
      return fits ? "end_turn" : "error";
    }, () => this.#emit({ ev: "usage", ctx: this.#lastContext, win: this.#window, out: 0 }));
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
      this.#provider = retrying(next.provider, this.#o.retry);
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
    this.#exclusive(async () => ((await this.#compact(true)) ? "compacted" : "error"));
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
    this.#restoreTodos();
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
      // That may have taken a while (a long conversation is summarised first), and a prompt sent meanwhile was queued: after a turn that
      // ended well it runs as the next turn. After a cancel or an error it is dropped, and every window is told: the person stopped it, or the turn failed.
      const rest = stop === "end_turn" ? this.#queue.shift() ?? this.#woken() : undefined;
      if (!rest) { this.#busy = false; this.#dropQueue(); }
      this.#emit({ ev: "done", stop });
      if (this.#o.hooks) void this.#o.hooks.stop({ reason: stop }).then((r) => { for (const note of r.notes) this.#emit({ ev: "notice", msg: note }); }).catch(() => undefined);
      if (rest) { this.#running = this.#turn(rest); await this.#running; }
    }
  }

  /**
   * A command ended, or printed what it was asked to watch for, and nobody is writing: the news starts a turn, so the model acts on it now and the person does not have to
   * ask. Never while a turn runs (the next request of that turn carries the news), never more than `MOST_WAKES` times without the person writing, and never twice within
   * `wakeGapMs`: what is waiting then waits for the gap to pass.
   */
  #woken(): Queued | undefined {
    if (!this.#o.wake || this.#closing.signal.aborted) return undefined;
    const news = this.#jobs.news().filter((n) => n.wake);
    if (!news.length || this.#wakes >= MOST_WAKES) return undefined;
    const wait = (this.#o.wakeGapMs ?? WAKE_GAP_MS) - (Date.now() - this.#wokeAt);
    if (wait > 0) { this.#wakeTimer ??= setTimeout(() => { this.#wakeTimer = undefined; this.#wakeNow(); }, wait); this.#wakeTimer.unref?.(); return undefined; }
    this.#wakes++;
    this.#wokeAt = Date.now();
    this.#jobs.told(news.map((n) => n.id));
    return { text: wakeText(news, (id) => this.#jobs.tail(id)), images: [], qid: crypto.randomUUID() };
  }

  #wakeNow(): void {
    if (this.#busy) return;
    const item = this.#woken();
    if (!item) return;
    this.#busy = true;
    this.#running = this.#turn(item);
  }

  #take(q: Queued, startsTurn = false): void {
    if (startsTurn) { this.#asked = 0; this.#webSeen = false; this.#turnQid = q.qid; this.#turnTokens = { in: 0, out: 0, calls: 0 }; }
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
      const skills = modelSkills(attempt(() => this.#o.skills?.()) ?? []);
      const offeredNow = toolsFor(this.#mode, this.#tools, { small, userText: this.#userText(), jobs: this.#jobs.running, steps: step, chat: this.#kind === "chat", typable: this.#jobs.typable, skills: skills.length, recall: this.#o.recall !== undefined });
      // A tool the model has used stays offered. Of the others, the ones that are not offered are named in the prompt, and a call to one of
      // them is run, not refused: the words that bring a tool in (the web, a helper) are a guess about the request, and a guess can be wrong.
      const allowedNow = (t: Tool): boolean => this.#mode !== "plan" || t.readOnly;
      const tools = [...offeredNow, ...this.#tools.filter((t) => this.#called.has(t.name) && allowedNow(t) && !offeredNow.some((o) => o.name === t.name))];
      const news = this.#jobs.news();
      const finished = news.flatMap(jobLines);
      // Named only where they can work: earlier conversations, and skills the agent may change, exist only in some places.
      const usable = (t: Tool): boolean => (t.name === "Recall" ? this.#o.recall !== undefined : t.name === "SkillManage" ? this.#o.skillBook !== undefined && this.#kind !== "chat" : true);
      const also = this.#tools.filter((t) => EXTRA.has(t.name) && usable(t) && allowedNow(t) && !tools.some((o) => o.name === t.name)).map((t) => t.name);
      const instructions = attempt(() => this.#o.instructions?.());
      const written = new TextToolCalls(Object.fromEntries(tools.map((t) => [t.name, t.parameters as { properties?: Record<string, { type?: string }> }])), `text${this.#messages.length}_`);
      let thinkingSince: number | undefined;
      const endThought = (): void => { if (thinkingSince !== undefined) { this.#emit({ ev: "thought_end", ms: Date.now() - thinkingSince }); thinkingSince = undefined; } };
      const said = (text: string): void => { if (text) { endThought(); this.#emit({ ev: "text", text }); } };
      const ask = (effort: Effort | undefined): Promise<ModelReply> => this.#provider.stream(
        {
          system: systemPrompt({ cwd: this.#o.cwd, platform: process.platform, date: (this.#o.now?.() ?? new Date()).toISOString().slice(0, 10), ...(this.#persona ? { persona: this.#persona } : {}), ...(this.#reference && asksAboutProgram(this.#lastUserText()) ? { reference: this.#reference } : {}), tools: tools.map((t) => t.name), ...(also.length ? { also } : {}), ...(finished.length ? { finished } : {}), ...(instructions ? { instructions } : {}), ...(skills.length ? { skills: skillsPrompt(skills, small)! } : {}), small, ...(this.#kind === "chat" ? { kind: "chat" as const, sandboxed: this.#o.sandboxed === true } : {}) }, this.#mode) + (this.#noTools.has(this.#model ?? "") ? `\n\n${toolsInPrompt(tools)}` : ""),
          messages: this.#noTools.has(this.#model ?? "") ? messagesAsText(this.#messages) : this.#messages,
          tools: this.#noTools.has(this.#model ?? "") ? [] : tools.map(({ name, description, parameters }) => ({ name, description, parameters })),
          ...(effort ? { effort } : {}),
        },
        this.#abort.signal,
        {
          text: (text) => said(written.push(text)),
          thought: (text) => { thinkingSince ??= Date.now(); this.#emit({ ev: "thought", text }); },
          toolStarted: (id, name) => { endThought(); if (name !== PLAN_TOOL_NAME) this.#emit({ ev: "tool", id, name, status: "running", progress: 0 }); },
          retry: (info) => this.#emit({ ev: "retry", ...info }),
        },
      );
      // A server that does not know the effort field answers 400; the same request goes again without it, once, and the model is taken as one without an effort setting.
      let model: ModelReply;
      try { model = await ask(this.#effort); }
      catch (e) {
        if (tools.length && !this.#noTools.has(this.#model ?? "") && refusesTools(e)) { this.#noTools.add(this.#model ?? ""); model = await ask(this.#effort); }
        else if (this.#effort && refusesEffort(e)) { this.#dropEffort(); model = await ask(undefined); }
        else throw e;
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
      this.#sinceTodo++;

      // Helpers (and other tools that only read) asked for in the same step run side by side; anything that may change something runs alone and in order, because it may need an answer from the person.
      const writesLater = (c: ToolCall): boolean => { // a helper allowed to change things must not run beside another one
        if (c.name !== AGENT_TOOL_NAME || (this.#mode !== "auto" && this.#mode !== "bypass")) return false;
        const named = parseLenient(c.arguments)?.agent;
        return typeof named === "string" && !!this.#o.agents?.find((d) => d.name === named)?.tools;
      };
      const together = reply.calls.length > 1 && reply.calls.every((c) => { const t = tools.find((x) => x.name === c.name); return t?.readOnly === true && !writesLater(c); });
      if (together) {
        const outputs = await Promise.all(reply.calls.map((call) => (this.#cancelled ? "[interrupted]" : this.#runTool(call, tools))));
        reply.calls.forEach((call, i) => this.#messages.push({ role: "tool", toolCallId: call.id, content: this.#toolMessage(outputs[i]!) }));
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
          this.#messages.push({ role: "tool", toolCallId: call.id, content: this.#toolMessage(output) });
        }
      }
      if (this.#pictures.length) this.#messages.push({ role: "user", content: [{ type: "text", text: "The picture from the tool result above:" }, ...this.#pictures.splice(0)] });
      // A message sent while the agent worked is folded in at this step boundary.
      const steer = this.#cancelled ? undefined : this.#queue.shift();
      if (steer) this.#take(steer);
    }
    this.#emit({ ev: "error", msg: `Stopped after ${this.#o.maxSteps} steps. Send a message to continue.` });
  }

  /** The person's answer to a question. One that already ended (nobody answered in time) reaches the model as a message from the person. */
  #answered(id: string, answers: string[][]): void {
    if (this.#questions.answer(id, answers)) return;
    const late = this.#expired.get(id);
    if (!late) return;
    this.#expired.delete(id);
    this.#prompt({ cmd: "prompt", text: `You asked, and the person has answered now:\n${answersText(late, answers)}` });
  }

  /** Asks the person to allow something: through this engine's own window, or, for a helper, through the engine that started it. */
  #approve(ask: ApprovalAsk): Promise<{ optionId: string; input?: string }> {
    if (this.#o.escalate) return this.#o.escalate(ask);
    const { id, answer } = this.#approvals.open();
    this.#emit({ ev: "approval", id, ...ask });
    return answer;
  }

  /** The Ask tool: the questions go to the person's window and wait; when nobody can answer, the model is told so and goes on. */
  async #askPerson(questions: QuestionItem[], signal: AbortSignal, tool: string): Promise<string> {
    if (this.#o.noQuestions || !attempt(() => this.#o.attended?.())) return NOBODY_ANSWERS;
    if (this.#asked >= MOST_QUESTIONS_PER_TURN) return "You have asked enough in this turn. Decide yourself, say what you assumed, and go on.";
    this.#asked++;
    const { id, answer } = this.#questions.open();
    this.#emit({ ev: "question", id, questions, tool });
    const wait = this.#o.askWaitMs ?? DEFAULT_ASK_WAIT_S * 1000;
    const timer = wait > 0 ? setTimeout(() => { this.#expired.set(id, questions); for (const old of [...this.#expired.keys()].slice(0, -20)) this.#expired.delete(old); this.#questions.close(id); }, wait) : undefined;
    const stop = (): void => this.#questions.close(id);
    signal.addEventListener("abort", stop, { once: true });
    try {
      const given = await answer;
      if (given) return answersText(questions, given);
      return signal.aborted ? "[interrupted]" : `No answer came in time. ${NOBODY_ANSWERS}`;
    } finally { clearTimeout(timer); signal.removeEventListener("abort", stop); }
  }

  /** The task list as the last TodoWrite of a saved conversation left it. */
  #restoreTodos(): void {
    this.#todos = []; this.#sinceTodo = 0;
    for (const m of [...this.#messages].reverse()) {
      const call = m.role === "assistant" ? [...(m.toolCalls ?? [])].reverse().find((c) => c.name === TODO_TOOL_NAME) : undefined;
      if (!call) continue;
      const parsed = parseTodos(parseLenient(call.arguments)?.todos);
      if ("entries" in parsed) this.#todos = parsed.entries;
      return;
    }
  }

  /** What the model reads of a tool's result: after some steps without touching an unfinished task list, a reminder is added. */
  #toolMessage(output: string): string {
    if (this.#sinceTodo < STALE_AFTER_STEPS || !this.#todos.some((e) => e.status !== "completed")) return output;
    const steps = this.#sinceTodo;
    this.#sinceTodo = 0;
    return `${output}\n${staleNote(steps)}`;
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

  /** Waits until fewer than the most helpers are working, then holds a place until `fn` ends. `held`: the place was taken already. */
  async #inSlot<T>(fn: () => Promise<T>, held = false): Promise<T> {
    const most = this.#o.helperLimits?.parallel ?? HELPER_PARALLEL;
    if (!held) {
      while (this.#helpersBusy >= most) await new Promise<void>((r) => this.#helperQueue.push(r));
      this.#helpersBusy++;
    }
    try { return await fn(); } finally { this.#helpersBusy--; this.#helperQueue.shift()?.(); }
  }

  /** Asks the person for a helper, one question at a time, so two helpers never put two questions on the same screen. */
  #relayApproval(ask: ApprovalAsk, parent: string): Promise<{ optionId: string; input?: string }> {
    const asked = this.#relay.then(() => this.#approve({ ...ask, title: `A helper asks: ${ask.title}`, tool: `${parent}.${ask.tool}` }));
    this.#relay = asked.catch(() => undefined);
    return asked;
  }

  /**
   * A helper: a second engine with the same model and only the tools that read (or the tools of a helper the person defined). It
   * has no conversation of its own to start from and no helpers of its own. In the foreground its steps are shown under the step
   * that asked and the result is the answer; in the background the call returns at once and the result comes back as a message.
   */
  async #delegate(parent: string, task: { description: string; prompt: string; agent?: string; background?: boolean }, signal: AbortSignal): Promise<string> {
    const def = task.agent ? this.#o.agents?.find((a) => a.name === task.agent) : undefined;
    // A helper may change things only when the person's own definition names the tools and the conversation is in Auto mode; in Plan mode nothing may change.
    const writes = !!def?.tools && (this.#mode === "auto" || this.#mode === "bypass");
    if (!task.background) return this.#inSlot(() => this.#helper(parent, task, def, writes, signal, true));
    if (writes && def?.isolation !== "worktree") return "Error: a helper that changes files works in the foreground, or in a copy of the project (isolation: worktree in its definition), never in the background beside you.";
    const most = this.#o.helperLimits?.parallel ?? HELPER_PARALLEL;
    if (this.#helpersBusy >= most) return `Error: ${most} helpers are already working. Wait for one to finish, or ask in the foreground.`;
    this.#helpersBusy++;
    const id = `helper${this.#nextHelper++}`;
    const own = new AbortController();
    this.#background.set(id, own);
    // Where a finished background helper is told to the model: a message, as a turn's steering or a turn of its own. A wake-up for finished commands (jobs) would use the same place.
    void this.#inSlot(() => this.#helper(parent, task, def, writes, own.signal, false), true).then((result) => {
      this.#background.delete(id);
      if (this.#closing.signal.aborted) return;
      this.#emit({ ev: "notice", msg: `A helper finished: ${task.description || task.prompt.slice(0, 60)}` });
      this.#prompt({ cmd: "prompt", text: `[Helper ${id} finished: ${task.description || task.prompt.slice(0, 60)}]\n${result}` });
    });
    return `Helper ${id} started in the background. Its answer arrives as a message when it ends; go on with other work.`;
  }

  async #helper(parent: string, task: { description: string; prompt: string; agent?: string }, def: AgentDef | undefined, writes: boolean, signal: AbortSignal, shown: boolean): Promise<string> {
    let answer = "";
    let steps = 0;
    const limits = this.#o.helperLimits ?? {};
    const copy = writes && def?.isolation === "worktree" ? await isolate(this.#o.cwd) : undefined;
    if (copy && "error" in copy) return `Error: ${copy.error}`;
    const allowed = def?.tools ? this.#tools.filter((t) => def.tools!.includes(t.name) && !NOT_FOR_HELPERS.has(t.name) && (writes || t.readOnly)) : this.#tools.filter((t) => t.readOnly && !NOT_FOR_HELPERS.has(t.name));
    const own = new AbortController();
    let late = false;
    const timer = setTimeout(() => { late = true; own.abort(); }, (limits.seconds ?? HELPER_SECONDS) * 1000);
    const helper = new Engine({
      provider: this.#provider, cwd: copy?.dir ?? this.#o.cwd, window: this.#window, heartbeatMs: 0, maxSteps: limits.steps ?? HELPER_STEPS,
      allowPrivateNetwork: this.#o.allowPrivateNetwork, noQuestions: true,
      ...(this.#o.noQuestions ? {} : { escalate: (ask: ApprovalAsk) => this.#relayApproval(ask, parent) }),
      tools: allowed,
      ...(this.#o.rules ? { rules: this.#o.rules } : {}),
      ...(this.#o.hooks ? { hooks: this.#o.hooks } : {}),
      persona: `${this.#persona ? `${this.#persona}\n\n` : ""}${def ? `You are the helper "${def.name}". ${def.prompt}\n\n` : ""}${HELPER_RULE}`,
      ...(this.#o.instructions ? { instructions: this.#o.instructions } : {}),
      ...(this.#o.search ? { search: this.#o.search } : {}),
      ...(this.#o.webProxy ? { webProxy: this.#o.webProxy } : {}),
      ...(this.#o.skills ? { skills: this.#o.skills } : {}),
      emit: (e) => {
        if (e.ev === "text") answer += e.text;
        else if (e.ev === "tool") { if (e.status === "running" && e.input !== undefined) { answer = ""; steps++; } if (shown) this.#emit({ ...e, id: `${parent}.${e.id}`, parent }); }
        else if (e.ev === "error") answer += `\n[the helper had a problem: ${e.msg}]`;
      },
    });
    const stop = (): void => helper.handle({ cmd: "cancel" });
    signal.addEventListener("abort", stop, { once: true });
    own.signal.addEventListener("abort", stop, { once: true });
    let said: string;
    try {
      helper.handle({ cmd: "prompt", text: task.prompt, mode: "auto" });
      await helper.idle();
      said = signal.aborted ? "[interrupted]" : (answer.trim() || (steps ? "The helper looked around but wrote no answer." : "The helper wrote no answer.")) + (late ? `\n[the helper ran out of time (${limits.seconds ?? HELPER_SECONDS} seconds)]` : "");
    } finally { clearTimeout(timer); signal.removeEventListener("abort", stop); await helper.shutdown(); }
    return `${said}${copy ? await copy.finish() : ""}`;
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
    const fail = (message: string, outcome?: ToolOutcome): string => { this.#emit({ ev: "tool", id: call.id, name: call.name, status: "error", output: message, startedAt: t0, ms: Date.now() - t0, ...(outcome ? { outcome } : {}) }); return message; };
    const tool = this.#toolFor(call.name, offered);
    if (tool) this.#called.add(tool.name);
    if (!tool) return fail(`Error: there is no tool "${call.name}". Use one of: ${offered.map((t) => t.name).join(", ")}${this.#mode === "plan" ? " (plan mode only allows reading)" : ""}.${offered.some((t) => t.name === "Bash") ? ' To run a command: Bash {"command": "ls -la"}' : ""}`);

    let args = parseLenient(call.arguments);
    if (!args) return fail(`Error: the arguments for ${call.name} must be a JSON object such as ${exampleArguments(tool.parameters)}. Send them again.`);
    if (tool.fixArgs) args = tool.fixArgs(args);
    const missing = (Array.isArray(tool.parameters.required) ? (tool.parameters.required as string[]) : []).filter((k) => args![k] === undefined);
    if (missing.length) return fail(`Error: ${tool.name} needs ${missing.join(", ")}: ${exampleArguments(tool.parameters)}. Send the call again with it.`);
    const bad = FILE_WRITERS.has(tool.name) ? this.#vault.restore(textOf(args)).unknown : [];
    if (bad.length) return fail(`Error: ${bad[0]} is not a value you can write: it stands for a secret you were not shown, or one this conversation does not know any more. To keep a value as it is, write the [hidden:N] mark that Read gave for it; otherwise ask the person for the value.`);
    this.#emit({ ev: "tool", id: call.id, name: tool.name, status: "running", input: this.#shown(args) });

    // What a mode means for this call is decided in one place for every engine.
    const judged = judge({ mode: this.#mode, tool, args, cwd: this.#o.cwd, rules: this.#o.rules, allowed: this.#allowed, knownUrl: (u) => this.#knownUrl(u), readable: this.#readable() });
    if (judged.kind === "stop") return fail(judged.message, "blocked");
    if (judged.kind === "ask") {
      const { scope, risk, strange } = judged;
      if (this.#o.noQuestions && !this.#o.escalate) return fail(`Blocked: this needs the person's say-so${risk ? ` (${risk.reason})` : ""}, and a helper cannot ask. Do not try again; say what you wanted to do.`, "blocked");
      {
        const change = approvalChange(tool.name, this.#shown(args));
        // A command can be changed by the person before it is allowed.
        const editable = tool.name === "Bash" && typeof args.command === "string" ? this.#vault.hide(args.command).text : undefined;
        const given = await this.#approve({ title: this.#vault.hide(strange ? `Open an address that was not in your request: ${String(args.url)}` : attempt(() => tool.title(args!)) ?? `Run ${tool.name}`).text, options: approvalOptions(scope.phrase, editable), tool: call.id, ...(change ? { change } : {}), ...(risk ? { risk: risk.reason } : {}) });
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
        } else if (given.optionId !== ALLOW && given.optionId !== EDIT) {
          // A no may carry what the person wants instead: the model is told in their words (a secret they typed stays hidden), not only that it was refused.
          const said = given.input?.trim();
          return fail(said ? `Not run. The person said: ${this.#vault.hide(said).text}` : "The user denied this action.", "denied");
        }
      }
    }
    if (this.#o.hooks) {
      const before = await this.#o.hooks.pre({ tool: tool.name, input: args }, this.#abort.signal).catch(() => ({ notes: [] as string[], block: undefined }));
      for (const note of before.notes) this.#emit({ ev: "notice", msg: note });
      if (before.block) return fail(`Blocked by a hook: ${before.block}`, "blocked");
    }
    if (this.#abort.signal.aborted) return fail("[interrupted]", "stopped");
    if (!tool.readOnly) this.#beforeWrite(tool.name, args);
    // How long it took is how long it ran, not how long the person took to answer.
    t0 = Date.now();

    // What a command prints is passed on a little at a time; how it ended is reported by the tool.
    let pending = "", sent = 0, timer: ReturnType<typeof setTimeout> | undefined;
    const flush = (): void => { timer = undefined; if (pending) { this.#emit({ ev: "tool", id: call.id, name: tool.name, status: "running", live: pending }); pending = ""; } };
    // What a running command prints is made safe as it arrives, before it reaches an event.
    const safe = new Redactor();
    const live = (raw: string): void => { const chunk = safe.push(raw); if (!chunk || sent > LIVE_MOST) return; sent += chunk.length; pending += chunk; timer ??= setTimeout(flush, LIVE_EVERY_MS); };
    let meta: { code?: number | null; truncated?: boolean; timedOut?: boolean; background?: boolean; cached?: boolean } = {};
    let output: string;
    try {
      output = await tool.run(this.#restored(tool.name, args), { cwd: this.#o.cwd, ...(isConfined(this.#kind) ? { root: this.#o.cwd } : {}), signal: this.#abort.signal, emit: (e) => { if (e.ev === "plan") { this.#todos = e.entries; this.#sinceTodo = 0; } this.#emit(e.ev === "plan" ? { ...e, ...(this.#turnQid ? { qid: this.#turnQid } : {}), tool: call.id } : e); }, ask: (q, s) => this.#askPerson(q, s, call.id), live, report: (m) => { meta = { ...meta, ...m }; }, allowPrivateNetwork: this.#o.allowPrivateNetwork, window: this.#window, shell: this.#shell, jobs: this.#jobs, env: childEnv(process.env, this.#o.env), ...(this.#o.backend ? { backend: this.#o.backend } : {}), ...(this.#o.recall ? { recall: this.#o.recall } : {}), ...(this.#o.search ? { search: this.#o.search } : {}), ...(this.#o.webProxy ? { webProxy: this.#o.webProxy } : {}), ...(this.#o.skills ? { skills: this.#o.skills } : {}), ...(this.#o.memory ? { memory: this.#o.memory } : {}), helper: (task, signal) => this.#delegate(call.id, task, signal), files: this.#files, show: (p) => { this.#pictures.push(p); }, ...(this.#vision !== undefined ? { vision: this.#vision } : {}), mode: this.#mode, ...(this.#webSeen ? { untrusted: true } : {}), ...(this.#o.skillBook ? { skillBook: this.#o.skillBook } : {}), ...(this.#o.skillApproval ? { skillApproval: this.#o.skillApproval } : {}) });
    } catch (e) { output = `Error: ${e instanceof Error ? e.message : String(e)}`; }
    clearTimeout(timer);
    flush();
    // Whatever a tool gave, no more than the window can spare reaches the model.
    if (tool.name === "Read" || tool.name === "Grep" || FILE_WRITERS.has(tool.name)) output = this.#unseen(output);
    output = withinBudget(tool.name, output, this.#window);
    if (WEB_TOOLS.has(tool.name)) this.#webSeen = true;
    const stopped = this.#abort.signal.aborted || output.endsWith("[interrupted]");
    const outcome: ToolOutcome | undefined = meta.timedOut ? "timeout" : stopped ? "stopped" : meta.background ? "background" : undefined;
    const failed = output.startsWith("Error:") || outcome === "timeout" || outcome === "stopped";
    this.#emit({ ev: "tool", id: call.id, name: tool.name, status: failed ? "error" : "done", output, startedAt: t0, ms: Date.now() - t0, ...(meta.code !== undefined ? { code: meta.code } : {}), ...(meta.truncated ? { truncated: true as const } : {}), ...(meta.cached ? { cached: true as const } : {}), ...(outcome ? { outcome } : {}) });
    if (this.#o.hooks) for (const note of (await this.#o.hooks.post({ tool: tool.name, input: args, output }, this.#abort.signal).catch(() => ({ notes: [] as string[] }))).notes) this.#emit({ ev: "notice", msg: note });
    return output;
  }

  async #compact(manual = false, keep: number = KEEP_TAIL): Promise<boolean> {
    this.#emit({ ev: "phase", name: "compacting" });
    if (this.#o.hooks?.compact) for (const note of (await this.#o.hooks.compact({ manual }, this.#abort.signal).catch(() => ({ notes: [] as string[] }))).notes) this.#emit({ ev: "notice", msg: note });
    try {
      const next = await compactMessages(this.#messages, this.#provider, this.#abort.signal, keep, { retry: (info) => this.#emit({ ev: "retry", ...info }) });
      if (!next) { if (manual) this.#emit({ ev: "error", msg: "Nothing to compact yet — the conversation is still short." }); return false; }
      const open = unfinished(this.#todos);
      if (open && typeof next[0]?.content === "string") next[0] = { ...next[0], content: `${next[0].content}\n\n${open}` };
      this.#messages = next;
      this.#files.forgetShown();
      this.#lastContext = estimateTokens(next);
      this.#emit({ ev: "usage", ctx: this.#lastContext, win: this.#window, out: 0 });
      this.#save();
      return true;
    } catch (e) {
      this.#emit({ ev: "error", msg: `Couldn't compact: ${e instanceof Error ? e.message : String(e)}` });
      return false;
    } finally { this.#emit({ ev: "phase", name: "" }); }
  }

  #beforeWrite(tool: string, args: Record<string, unknown>): void {
    for (const file of changedPaths(tool, args)) {
      const target = resolve(this.#o.cwd, file);
      this.#written.add(target);
      if (this.#checkpoint) attempt(() => this.#o.checkpoints?.add(this.#checkpoint!, target));
    }
  }

  #save(): void { try { this.#o.store?.save(this.sessionId, this.#messages); } catch { /* a full disk must not kill the turn */ } }
  /** The arguments of a call as a window or a log may show them: every secret in them is a mark. */
  #shown(args: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(Object.entries(args).map(([k, v]) => [k, typeof v === "string" ? this.#vault.hide(v).text : v]));
  }

  /** Whether an address came from the person, a search or a page that was read: only those may be fetched without asking. */
  #knownUrl(url: unknown): boolean {
    if (typeof url !== "string") return false;
    const key = (u: string): string => PageCache.key(u).replace(/\/$/, "");
    const urls = (t: string): string[] => (t.match(/https?:\/\/[^\s<>"')\]]+/g) ?? []).map((u) => u.replace(/[.,;:!?]+$/, ""));
    const names = new Map<string, string>();
    const known = new Set<string>();
    for (const m of this.#messages) {
      const text = typeof m.content === "string" ? m.content : (m.content ?? []).map((p) => (p.type === "text" ? p.text : "")).join(" ");
      if (m.role === "assistant") for (const c of m.toolCalls ?? []) names.set(c.id, c.name);
      else if (m.role === "user" || (m.role === "tool" && ["WebSearch", "WebFetch"].includes(names.get(m.toolCallId ?? "") ?? ""))) for (const u of urls(text)) known.add(key(u));
    }
    return known.has(key(url));
  }

  /** The folders outside the project that the program keeps things in for the model: its long output, what was attached, its notes and the skills. */
  #readable(): string[] {
    const m = this.#o.memory;
    return [SPILL_DIR, this.#attachmentDir(), ...(m ? [m.project, ...(m.user ? [m.user] : [])] : []), ...(attempt(() => this.#o.skills?.()) ?? []).map((s) => s.dir)];
  }

  /** The arguments of a call that changes files with the marks put back as the values they stand for: only the file ever gets them. */
  #restored(tool: string, args: Record<string, unknown>): Record<string, unknown> {
    return FILE_WRITERS.has(tool) ? mapText(args, (t) => this.#vault.restore(t).text) : args;
  }

  /** What the model is given of a file or a search: the secrets in it are marks, and it is told once what the marks are. */
  #unseen(text: string): string {
    const h = this.#vault.hide(text);
    return h.count ? `${h.text}\n[${h.count} secret ${h.count === 1 ? "value is" : "values are"} hidden as [hidden:N] marks; write a mark in Edit or Write to keep that value as it is]` : h.text;
  }

  #emit(event: EngineEvent): void { attempt(() => this.#o.emit(event)); }
}
