/**
 * The engine: one conversation, one agent loop. It receives protocol commands and emits protocol events; everything it needs
 * from the outside (model provider, session store, tools, clock) is passed in, so a whole run can be tested against a script.
 */
import { RetryProvider, type RetryOptions } from "./providers/retry.ts";
import { historyOf } from "./store.ts";
import { dirname, join, relative, resolve } from "node:path";
import { REFUSED, RecentIds, type McpPromptInfo, type ApprovalOption, type Command, type Effort, type EngineEvent, type FileNote, type ModelInfo, type PermMode, type PictureInfo, type PlanEntry, type QuestionItem, type PromptCommand, type SessionKind, type ScreenAsk, type UploadAsk, type PromptFrom, type ScreenOutcome, type StopReason, type ToolOutcome, type TurnTokens } from "@navvied/protocol";
import { ALLOW, ALLOW_ALWAYS, ApprovalBroker, EDIT, approvalOptions, type ApprovalAnswer } from "./approvals.ts";
import type { Checkpoint, Checkpoints } from "./checkpoints.ts";
import type { AgentEngine } from "./contract.ts";
import { KEEP_TAIL, compactMessages, estimateTokens, shouldCompact } from "./context.ts";
import { parseLenient } from "./lenient-json.ts";
import type { HookSaid, Hooks, PreVerdict } from "./hooks.ts";
import type { McpBrowse } from "./mcp-tools.ts";
import { keep, pendingEvent, type MemoryPaths } from "./memory.ts";
import type { MediaFile, MediaShelf } from "./media/shelf.ts";
import { extractByModel, extractByRules, type Proposal } from "./memory-extract.ts";
import { approvalChange } from "./approval-change.ts";
import { Jobs } from "./jobs.ts";
import { DEFAULT_ASK_WAIT_S, MOST_QUESTIONS_PER_TURN, NOBODY_ANSWERS, QuestionBroker, answersText } from "./questions.ts";
import { isolate } from "./worktree.ts";
import { McpAnswers, type McpHost } from "./mcp-host.ts";
import { Sampler } from "./mcp-sampling.ts";
import { Elicitor } from "./mcp-elicit.ts";
import { jobLines, wakeText } from "./job-note.ts";
import type { EnvPolicy } from "./child-env.ts";
import { ChildEnv } from "./process-start.ts";
import { Redactor, hideSecrets, registerSecrets, secretsIn, secretsNow } from "./redact.ts";
import { originsIn } from "./tools/browser/credentials.ts";
import { forget, type ShellState } from "./tools/shell-state.ts";
import { modelSkills, skillsPrompt, type SkillInfo } from "./skills.ts";
import type { SkillBook } from "./skill-book.ts";
import { messagesAsText, toolsInPrompt } from "./text-tools.ts";
import { TextToolCalls, dollarCommand } from "./text-tool-calls.ts";
import type { Backend } from "./backend.ts";
import { CodeOffer, type CodeAfter } from "./code-offer.ts";
import { inMode, offeredIn } from "./permissions.ts";
import { approvalScope } from "./approval-scope.ts";
import { judge, type Judgement } from "./judge.ts";
import { DEFAULT_SETTING, Sandbox, type Denial, type Setting } from "./sandbox/index.ts";
import { isConfined, profileTools } from "./profiles.ts";
import { hardBlock, nativePaths, type Paths, type Rules } from "./rules.ts";
import { homeFrom } from "./where.ts";
import { systemPrompt } from "./prompt.ts";
import { PLAN_TOOL_NAME, defaultTools } from "./tools/index.ts";
import { EXECUTE_CODE_TOOL } from "./tools/execute-code.ts";
import { PROMPTS, RESOURCES } from "./mcp-extras.ts";
import { browserHere } from "./tools/browser.ts";
import { COMPUTER_TOOL, computer } from "./tools/computer.ts";
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
import { ASK_AGENT_TOOL_NAME, askAgentTool } from "./tools/ask-agent.ts";
import { STALE_AFTER_STEPS, TODO_TOOL_NAME, parseTodos, staleNote, unfinished } from "./tools/todo.ts";
import { Outside, withOrigin } from "./taint.ts";
import { sourceOf, untrusted } from "./tools/untrusted.ts";
import type { AgentDef } from "./agents.ts";
import type { Media } from "./media/media.ts";
import type { ComputerHelper, Message, ModelReply, Part, PeerBook, Provider, Recall, ScheduleBackend, SessionStore, Tool, ToolCall, ToolContext, WebProxy } from "./types.ts";

/** What the engine asks of the connected programs for a person: their prompts, and the text of one. */
interface McpPrompts { prompts(): Promise<McpPromptInfo[]>; prompt(server: string, name: string, args: Record<string, string>, signal: AbortSignal): Promise<string> }

/** What a helper needs the person to decide: the fields of an `approval` event, before the engine gives it an id. */
type ApprovalAsk = { title: string; options: ApprovalOption[]; tool: string; screen?: ScreenAsk; upload?: UploadAsk; change?: Extract<EngineEvent, { ev: "approval" }>["change"]; risk?: string };

/** What the engine needs to let a person switch models in the middle of a conversation. */
export interface ModelSwitch {
  /** What can be switched to. The engine marks the one in use. */
  models: ModelInfo[];
  /** The id of the one in use. */
  current: string;
  /** The effort levels the model in use supports; none when it has no such setting. */
  efforts?: Effort[];
  /** What it takes to use another: its provider and window, and the effort levels it supports. */
  use(id: string): { provider: Provider; window: number; small?: boolean; efforts?: Effort[]; persona?: string; reference?: string; vision?: boolean } | { error: string };
}

export interface EngineOptions {
  provider: Provider;
  /** When the script tool, if switched on, is offered: `auto` (default) as the turn shows it pays, `always` from the first request (for measuring what that costs). `after` sets the limits. */
  codeOffer?: { mode?: "auto" | "always"; after?: CodeAfter };
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
  /** The model is a small one that runs here: it gets few tools and a short prompt. Decided by the model, never by its window: a hosted model with a short window still gets every tool, with shorter results. */
  small?: boolean;
  emit: (event: EngineEvent) => void;
  store?: SessionStore;
  /** Continue a saved session (needs `store`). */
  sessionId?: string;
  persona?: string;
  /** Keys the program knows from its configuration: they are hidden from everything a command prints. */
  secrets?: string[];
  /** What the person may ask about this program (its commands, modes, files): put in the prompt only for a request that asks about it. */
  reference?: string;
  /** The standing instructions, asked for at every step with what the person last wrote, so the notes put in front of the model can be the ones that fit it. */
  instructions?: (request?: { userText: string }) => string | undefined;
  /** Awaited before `instructions` is asked for, with what the person last wrote: where what the notes need from a server (the likeness of meaning) is got. It must be quick to give up; a failure is ignored. */
  prepare?: (request: { userText: string }) => Promise<void>;
  checkpoints?: Checkpoints;
  tools?: Tool[];
  /** Whether the model is offered `apply_patch`: `auto` (default) when its window is not small, `on` always, `off` never. */
  applyPatch?: "auto" | "on" | "off";
  /** Where Bash runs its commands: a container or another machine instead of this computer. */
  backend?: Backend;
  /** Nobody can be asked (a helper): what would be asked about is refused instead, unless `escalate` hands it to someone who can answer. */
  noQuestions?: boolean;
  /** A helper's way to the person: the question is asked by the engine that started the helper. */
  escalate?: (question: ApprovalAsk) => Promise<ApprovalAnswer>;
  /** Whether a person is looking at this conversation right now (a window or a terminal is attached). Without it nobody is: a question is not waited for. */
  attended?: () => boolean;
  /** How long a question waits for the person, in milliseconds (default: ten minutes with a window attached, no wait without). */
  askWaitMs?: number;
  /** What helpers may use: how many work at once, how many steps and how many seconds each may take. */
  helperLimits?: { parallel?: number; steps?: number; seconds?: number };
  /** The person's earlier conversations, for the Recall tool. */
  recall?: Recall;
  /** Where the Schedule tool keeps its jobs; without it the tool is not offered. */
  schedule?: ScheduleBackend;
  /** What drives this computer's screen: given when computer use is on, and only then is the `computer` tool there. A function is asked once at the start of each turn, so the switch the person flips applies to the open conversation: the tool is offered from the next turn while it answers a helper, and not while it answers nothing. */
  computer?: ComputerHelper | (() => ComputerHelper | undefined);
  /** Where each tool keeps what it makes (the pictures of the Browser tool): a folder under the program's own, by the tool's name. Without it nothing is kept. */
  toolFolder?: (tool: string) => string;
  /** Where the pictures, sounds and videos the steps make are kept for a page to fetch (`media.read`). Without it a step carries no `media`. */
  shelf?: MediaShelf;
  allowPrivateNetwork?: boolean;
  /** Other agents the person set up: the AskAgent tool exists only when there is one. */
  peers?: PeerBook;
  /** Everything this conversation is given comes from outside (an agent that is not the person's): the file tools stay in the folder, and what the agent keeps is marked so from the first step. */
  outside?: true;
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
  /** What can hear, speak, draw or look at media here (see media/media.ts); without it the tools of media are not offered. */
  media?: Media;
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
  /** Notes that fill themselves after a turn that ended well: `rules` (default) proposes what the person stated outright, `model` adds one bounded call through this provider, `off` never. */
  memoryExtract?: "off" | "rules" | "model";
  /** What a command may not inherit from this program's environment (see child-env.ts). */
  env?: EnvPolicy;
  /** What `~` stands for (default: `HOME` of this process's environment). */
  home?: string;
  /** Where background commands keep their output and the record a restart finds them by; without it nothing is taken back after a restart. */
  jobsDir?: string;
  /** A command that ended, or printed what it was asked to watch for, starts a turn by itself when the conversation is idle (the host that shows the conversation says so). */
  wake?: boolean;
  /** The least time between two such turns, in ms (default 2000). */
  wakeGapMs?: number;
  /** Whether a tool may be used now: asked at every step, so a tool the person switches off is no longer offered, and a call to it is refused by name. */
  toolOn?: (name: string) => boolean;
  /** How the agent makes and changes skills (the SkillManage tool), and how a change is handled: it waits for the person (`ask`) or is made and can be undone (`auto`). */
  skillBook?: SkillBook;
  skillApproval?: () => "ask" | "auto";
  /** What the conversation is for (default `agent`). A `chat` works in `cwd` only, offers a smaller set of tools and asks the person nothing. */
  kind?: SessionKind;
  /** The program runs inside a sandbox, so a chat may run commands too. */
  sandboxed?: boolean;
  /** How commands on this computer are confined (see sandbox/): the person's choice, read again for every command, and the files of the program itself that hold keys. Confined, with the network on, unless the choice says otherwise. */
  confinement?: { setting?: () => Partial<Setting>; hide?: () => string[] };
  /** The one model in use, for a page that shows it, when there is no list to switch between. */
  model?: ModelInfo;
}

/** `attached` is what the model is told about the files, `parts` the pictures and PDFs that go with it, `files` what the person's window is told. */
interface Queued { qid?: string; text: string; images: NonNullable<PromptCommand["images"]>; attached?: string; parts?: Part[]; files?: FileNote[]; from?: PromptFrom }

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

/** What the model is told when it ends its turn in words right after a question, with nothing done. */
const ANSWERED = "[The person answered. Do it.]";
const NOBODY_NOTE = "[Nobody can answer. Pick the most reasonable option, say what you assumed, and do it.]";
/** What the model is told when it ends its turn with steps of its task list still open. */
const TODO_OPEN = "[The task list still has open steps. Do them, or say what blocks you.]";
/** Tools that are named in the prompt, without their definitions, when the request has not brought them in. */
const EXTRA = new Set(["WebSearch", "WebFetch", "Agent", "Remember", "Recall", "SkillManage", "TodoWrite", "Schedule", "Transcribe", "Speak", "MakeImage", "MakeVideo", "LookAt", "Watch", "Browser", "NotebookEdit", RESOURCES, PROMPTS, COMPUTER_TOOL, ASK_AGENT_TOOL_NAME]);

/** A model that runs on this computer with a window this small, or smaller, is a small one (see `smallModel`). */
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
const NOT_FOR_HELPERS = new Set([AGENT_TOOL_NAME, ASK_TOOL_NAME, TODO_TOOL_NAME, COMPUTER_TOOL, ASK_AGENT_TOOL_NAME]);

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

/** A value with `hide` applied to every text in it, at any depth. */
function hideIn(v: unknown, hide: (t: string) => string): unknown {
  if (typeof v === "string") return hide(v);
  if (Array.isArray(v)) return v.map((x) => hideIn(x, hide));
  return v !== null && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, hideIn(x, hide)])) : v;
}

/** The arguments of a call as the text the model wrote, with the secrets in it hidden: read as JSON when they are JSON, so an escaped value is found too. */
function hideArguments(args: string, hide: (t: string) => string): string {
  const parsed = parseLenient(args);
  return parsed ? JSON.stringify(hideIn(parsed, hide)) : hide(args);
}

/** Run a collaborator's code that must never be able to stop a turn: a failure counts as "no result". */
function attempt<T>(fn: () => T): T | undefined {
  try { return fn(); } catch { return undefined; }
}

export class Engine implements AgentEngine {
  sessionId: string;
  readonly #o: Required<Pick<EngineOptions, "provider" | "cwd" | "window" | "emit" | "maxSteps" | "allowPrivateNetwork">> & EngineOptions;
  readonly #tools: Tool[];
  /** The tools that are on: what is offered, named or handed to a helper. */
  get #on(): Tool[] {
    const on = this.#o.toolOn, media = this.#o.media;
    // A tool of media is on only where something can do its work: a computer with nothing set up is never offered it.
    return (on ? this.#tools.filter((t) => on(t.name)) : this.#tools.filter((t) => !t.experimental)).filter((t) => !t.needs || media?.has(t.needs)).filter((t) => t.name !== COMPUTER_TOOL || this.#computer !== undefined);
  }
  /** The helper of the screen as of the start of this turn (see `EngineOptions.computer`). */
  #computer: ComputerHelper | undefined;
  #askComputer(): ComputerHelper | undefined {
    const c = this.#o.computer;
    return typeof c === "function" ? attempt(c) : c;
  }
  readonly #disposers: (() => void)[] = [];
  /** What tools keep for the conversation (see `ToolContext.keep`). */
  readonly #kept = new Map<string, { close(): void }>();
  #loading: Promise<void>[] = [];
  /** The connected programs, for the prompts a person may pick. */
  readonly #connections: (McpPrompts & Partial<McpBrowse>)[] = [];
  readonly #approvals = new ApprovalBroker();
  readonly #questions = new QuestionBroker();
  /** What the connected programs may ask of the model and of the person (see mcp-host.ts). */
  readonly #mcpAnswers: McpAnswers;
  /** Questions nobody answered in time, by id: an answer that comes later is told to the model as a message. */
  readonly #expired = new Map<string, QuestionItem[]>();
  /** Questions asked in the turn that is running. */
  #asked = 0;
  /** The task list the model keeps, and the model's steps since it last touched it. */
  #todos: PlanEntry[] = [];
  #sinceTodo = 0;
  /** The turn has already been sent back to work once (see {@link Engine.#unfinishedTurn}). */
  #continued = false;
  /** The model has put a question to the person in this turn (answered or not). */
  #questioned = false;
  /** What the last question of this turn came to (the person answered, or nobody could), and the tool calls the model has made since. */
  #questionEnd: "none" | "answered" | "nobody" = "none";
  #sinceAnswer = 0;
  /** Helpers at work: how many hold a place, who waits for one, and the ones started in the background (to stop them). */
  #helpersBusy = 0;
  readonly #helperQueue: (() => void)[] = [];
  readonly #background = new Map<string, AbortController>();
  /** Each background helper until its answer has been handed to the conversation (see {@link idle}). */
  readonly #helpers = new Set<Promise<void>>();
  #nextHelper = 1;
  #relay: Promise<unknown> = Promise.resolve();
  readonly #queue: Queued[] = [];
  /** A model chosen while a turn was being answered: it is used from the next one. */
  #wantModel: string | undefined;
  #messages: Message[] = [];
  #mode: PermMode = "auto";
  /** Text from the web has come into this turn: what the agent saves from here on is marked as such. */
  readonly #outside = new Outside();
  readonly #codeOffer: CodeOffer;
  get #kind(): SessionKind { return this.#o.kind ?? "agent"; }
  #effort: Effort | undefined;
  #provider: Provider;
  #window: number;
  #small: boolean;
  #vision: boolean | undefined;
  /** The files this conversation has read or written, which the tools that change files check. */
  readonly #files = new FileState();
  /** Pictures a tool handed over this step: they reach the model in a message after the results. */
  #pictures: { part: Part; call: string }[] = [];
  /** What the saved conversation keeps instead of a result that is for the model only (a capture of the screen). */
  readonly #keptOut = new Map<Message, string>();
  /** The note of each such result of the step now running, by the call that made it. */
  readonly #notes = new Map<string, string>();
  /** The kind of each such result, by call: a newer result replaces only the older ones of its own kind (the same page of the browser, the screen). */
  readonly #kinds = new Map<string, string>();
  readonly #keptKind = new Map<Message, string>();
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
  /** How many messages were already looked through for facts worth a note. */
  #learnedTo = 0;
  /** The notes the person's words of this turn will become (shown to the model as being saved), and whether the model itself kept a note this turn. */
  #noting: string[] = [];
  #keptByModel = false;
  /** The last turn was started by a stop hook asking for another round. */
  #stopHooked = false;
  #cancelled = false;
  /** Kinds of action the person said not to ask about again, until this engine closes. */
  readonly #allowed = new Set<string>();
  readonly #jobs: Jobs;
  readonly #sandbox: Sandbox;
  /** Turns started by the news of a command since the person last wrote, and when the last began. */
  #wakes = 0;
  #wokeAt = -Infinity;
  #wakeTimer: ReturnType<typeof setTimeout> | undefined;
  /** The secrets this conversation has met in files and commands, behind the marks that stand for them. */
  readonly #vault = new Vault();
  /** Secrets the person typed in their own messages, which of them a tool call has used, and which they were told about. */
  readonly #typed = new Set<string>();
  #hidden = new WeakMap<Message, Message>();
  #hiddenFor = "";
  readonly #shell: ShellState = {};
  /** What `~` is for every tool, rule and risk of this conversation: the home of the environment the engine was given. */
  readonly #paths: Paths;
  /** The tools offered so far in this conversation. A tool is added only by a need that is plain (a program connected, a command running, a tool switched on), never taken out, so the list the model gets, and the prompt's prefix with it, stays as it was. */
  readonly #offered = new Set<string>();
  readonly #closing = new AbortController();
  #abort = new AbortController();
  #lastContext = 0;
  #written = new Set<string>();
  #checkpoint: Checkpoint | undefined;
  #running: Promise<void> = Promise.resolve();
  #heartbeat: ReturnType<typeof setInterval> | undefined;

  constructor(opts: EngineOptions) {
    this.#paths = { ...nativePaths, home: opts.home ?? homeFrom() };
    this.#o = { maxSteps: 60, allowPrivateNetwork: false, ...opts };
    this.#computer = this.#askComputer();
    this.#codeOffer = new CodeOffer(opts.codeOffer?.after, opts.codeOffer?.mode === "always");
    this.#provider = retrying(opts.provider, opts.retry);
    this.#mcpAnswers = new McpAnswers(
      new Sampler({
        run: async (system, messages, signal, text) => (await this.#provider.stream({ system, messages, tools: [] }, AbortSignal.any([signal, this.#abort.signal]), { text, thought: () => undefined, toolStarted: () => undefined })).content,
        model: () => this.#model ?? "the model in use",
        attended: () => this.#canAsk(),
        bypass: () => this.#mode === "bypass",
        approve: (ask) => this.#approve(ask),
        hide: (text) => this.#vault.hide(text, this.#secrets()).text,
      }),
      new Elicitor({
        ask: (questions, signal, server) => this.#question(questions, AbortSignal.any([signal, this.#abort.signal]), `mcp:${server}`),
        attended: () => this.#canAsk(),
        secret: (value) => { this.#typed.add(value); },
      }),
    );
    this.#window = opts.window;
    this.#small = opts.small === true;
    this.#vision = opts.vision;
    registerSecrets(opts.secrets ?? []);
    this.#persona = opts.persona;
    this.#reference = opts.reference;
    this.#model = opts.switcher?.current;
    this.#efforts = opts.switcher?.efforts ?? opts.efforts;
    this.#tools = profileTools(opts.kind ?? "agent", [...(opts.tools ?? defaultTools({ applyPatch: opts.applyPatch })), ...(opts.computer !== undefined && !opts.tools?.some((t) => t.name === COMPUTER_TOOL) ? [computer] : [])], { sandboxed: opts.sandboxed === true }).map((t) => (t.name === AGENT_TOOL_NAME && opts.agents?.length ? agentTool(opts.agents) : t));
    if (opts.peers?.names.length && (opts.kind ?? "agent") === "agent") this.#tools.push(askAgentTool(opts.peers.names));
    this.sessionId = opts.sessionId ?? crypto.randomUUID();
    this.#jobs = new Jobs((e) => this.#emit(e), Date.now, { session: this.sessionId, ...(opts.jobsDir ? { dir: opts.jobsDir } : {}), env: () => ChildEnv.scrubbed(process.env, opts.env), onNews: () => this.#wakeNow(), ...(opts.wake ? { wake: true } : {}) });
    this.#sandbox = new Sandbox({ home: this.#paths.home!, setting: () => ({ ...DEFAULT_SETTING, ...opts.confinement?.setting?.() }), extra: () => [this.#attachmentDir(), ...(opts.jobsDir ? [opts.jobsDir] : [])], ...(opts.confinement?.hide ? { hide: opts.confinement.hide } : {}), ...(opts.sandboxed ? { nested: true } : {}) });
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
      case "approve": this.#approvals.answer(cmd.id, cmd.optionId, cmd.input, cmd.unasked); return;
      case "answer": return this.#answered(cmd.id, cmd.answers);
      case "compact": return this.#compactCommand();
      case "model": return this.#useModel(cmd.id);
      case "effort": return this.#setEffort(cmd.level);
      case "load": return this.#load(cmd.id);
      case "sessions": return this.#emit({ ev: "sessions", items: this.#o.store?.list?.() ?? [] });
      case "checkpoints": return this.#listCheckpoints();
      case "restore": return this.#restore(cmd.id, cmd.preview === true);
      case "mcp.prompts": void this.#mcpPrompts(); return;
      case "mcp.prompt": void this.#mcpPrompt(cmd); return;
      case "mcp.resources": void this.#mcpResources(cmd.server); return;
      case "mcp.resource": void this.#mcpResource(cmd.server, cmd.uri); return;
      case "mcp.tools": void this.#mcpTools(cmd.query, cmd.server); return;
    }
  }

  async #mcpPrompts(): Promise<void> {
    await Promise.all(this.#loading.splice(0));
    this.#emit({ ev: "mcp.prompts", items: (await Promise.all(this.#connections.map((c) => c.prompts().catch(() => [])))).flat() });
  }

  /** The documents the connected programs offer, for a page. */
  async #mcpResources(server?: string): Promise<void> {
    await Promise.all(this.#loading.splice(0));
    const got = await Promise.all(this.#connections.map((c) => c.resources?.(server)));
    const problems = got.flatMap((g) => g?.problems ?? []);
    this.#emit({ ev: "mcp.resources", items: got.flatMap((g) => g?.items ?? []), ...(problems.length ? { problems } : {}) });
  }

  /** One document of a connected program, for a page. */
  async #mcpResource(server: string, uri: string): Promise<void> {
    await Promise.all(this.#loading.splice(0));
    let why = `No connected program "${server}" has documents.`;
    for (const c of this.#connections) {
      if (!c.readResource) continue;
      try { this.#emit({ ev: "mcp.resource", server, uri, contents: await c.readResource(server, uri, this.#closing.signal) }); return; }
      catch (e) { why = e instanceof Error ? e.message : String(e); }
    }
    this.#emit({ ev: "error", msg: `The document could not be read: ${why}` });
  }

  /** The tools of the connected programs that fit some words, as the model finds them when they are too many to list; nothing is offered to the model by it. */
  async #mcpTools(query?: string, server?: string): Promise<void> {
    await Promise.all(this.#loading.splice(0));
    const got = this.#connections.map((c) => c.find?.(query, server));
    this.#emit({ ev: "mcp.tools", query: query ?? "", items: got.flatMap((g) => g?.items ?? []).slice(0, 50), total: got.reduce((n, g) => n + (g?.total ?? 0), 0) });
  }

  /** A prompt of a connected program, run as the person's own request. */
  async #mcpPrompt(cmd: Extract<Command, { cmd: "mcp.prompt" }>): Promise<void> {
    await Promise.all(this.#loading.splice(0));
    const offers = await Promise.all(this.#connections.map(async (c) => ((await c.prompts().catch(() => [])).some((p) => p.server === cmd.server && p.name === cmd.name) ? c : undefined)));
    const from = offers.find((c) => c !== undefined);
    if (!from) { this.#emit({ ev: "error", msg: `No connected program "${cmd.server}" has a prompt "${cmd.name}".` }); return; }
    try { this.#prompt({ cmd: "prompt", text: await from.prompt(cmd.server, cmd.name, cmd.args ?? {}, this.#closing.signal) }); }
    catch (e) { this.#emit({ ev: "error", msg: `The prompt "${cmd.name}" could not be fetched: ${e instanceof Error ? e.message : String(e)}` }); }
  }

  /** Hand this to `connectMcp`: the connected programs may then ask for a model answer or put a question to the person, each as the engine and the configuration allow. */
  get mcpHost(): McpHost { return this.#mcpAnswers; }

  /** Add tools after the engine has started, such as those of connected programs. They are offered from the next step. `dispose` runs when the engine closes. */
  addTools(tools: Tool[], dispose?: () => void): void {
    for (const t of tools) if (!this.#tools.some((x) => x.name === t.name)) this.#tools.push(t);
    if (dispose) this.#disposers.push(dispose);
  }

  /** Tools that are still being connected. The first step of the next turn waits for them, so no turn starts without tools that are about to arrive. Programs that fail are reported as errors, and the rest go on. */
  loadTools(load: Promise<{ tools: Tool[]; close(): void; problems?: { server: string; reason: string; signin?: true }[] } & Partial<McpPrompts> & Partial<McpBrowse>>): void {
    this.#loading.push(load.then((c) => {
      if (this.#closing.signal.aborted) { attempt(() => c.close()); return; }
      this.addTools(c.tools, () => c.close());
      if (c.prompts && c.prompt) this.#connections.push({ prompts: c.prompts, prompt: c.prompt, ...(c.resources ? { resources: c.resources } : {}), ...(c.readResource ? { readResource: c.readResource } : {}), ...(c.find ? { find: c.find } : {}) });
      for (const p of c.problems ?? []) {
        this.#emit({ ev: "notice", msg: `The connected program "${p.server}" could not be used: ${p.reason}` });
        if (p.signin) this.#emit({ ev: "mcp.signin", server: p.server, state: "needed" });
      }
    }, () => undefined));
  }

  /** Until the turn has ended and no background helper is still working: a helper's answer arrives as a turn of its own, so that turn is waited for too. A cancelled turn does not wait for them. */
  async idle(): Promise<void> {
    for (;;) {
      await this.#running;
      if (this.#cancelled || !this.#helpers.size) return;
      await Promise.race(this.#helpers);
    }
  }

  /** Aborted when the engine is closed: what is still being connected (see `connectMcp`) is stopped then. */
  get closing(): AbortSignal { return this.#closing.signal; }

  /** Closes the engine and waits until what it started has exited, so the folder it worked in can be removed. */
  async shutdown(): Promise<void> {
    this.close();
    await this.#jobs.stopped();
  }

  close(): void {
    if (!this.#closing.signal.aborted && this.#hooked) void this.#o.hooks?.end?.({ reason: "closed" }).then((r) => { for (const note of r.notes) this.#emit({ ev: "notice", msg: note }); }).catch(() => undefined);
    this.#closing.abort();
    clearTimeout(this.#wakeTimer);
    this.#cancel();
    for (const c of this.#background.values()) c.abort();
    this.#jobs.close();
    this.#sandbox.close();
    forget(this.#shell);
    for (const dispose of this.#disposers.splice(0)) attempt(dispose);
    for (const kept of this.#kept.values()) attempt(() => kept.close());
    this.#kept.clear();
    if (this.#heartbeat) clearInterval(this.#heartbeat);
  }

  #prompt(cmd: PromptCommand): void {
    if (cmd.qid && !this.#qids.isNew(cmd.qid)) return;
    this.#wakes = 0;
    if (cmd.mode && this.#kind === "agent") this.#mode = cmd.mode;
    if (cmd.effort) this.#effort = cmd.effort;
    const item: Queued = { text: cmd.text, images: cmd.images ?? [], ...(cmd.qid ? { qid: cmd.qid } : {}), ...(cmd.from ? { from: cmd.from } : {}) };
    this.#attach(item, cmd);
    if (this.#busy) { this.#queue.push(item); if (item.qid) this.#emit({ ev: "queued", qid: item.qid, text: item.text, ...(item.images.length ? { images: item.images.length } : {}), ...(item.files?.length ? { files: item.files } : {}), ...(item.from ? { from: item.from } : {}) }); return; }
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
      this.#small = next.small === true;
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
    this.#offered.clear();
    this.#restoreTodos();
    this.sessionId = id;
    this.#emit({ ev: "loaded", id, items: historyOf(saved) });
    this.#emit({ ev: "usage", ctx: estimateTokens(saved), win: this.#window, out: 0 });
  }

  async #turn(first: Queued): Promise<void> {
    this.#cancelled = false;
    this.#abort = new AbortController();
    this.#computer = this.#askComputer();
    let stop: StopReason = "end_turn";
    try {
      let next: Queued | undefined = first;
      while (next) {
        if (this.#o.hooks?.prompt) {
          const verdict = await this.#o.hooks.prompt({ text: next.text, first: !this.#hooked }, this.#abort.signal).catch(() => ({ notes: [] as string[], block: undefined, context: undefined }));
          this.#hooked = true;
          for (const note of verdict.notes) this.#emit({ ev: "notice", msg: note });
          this.#hookSaid((verdict as { said?: HookSaid[] }).said);
          if (verdict.block) { this.#emit({ ev: "error", msg: `Blocked by a hook: ${verdict.block}` }); next = this.#queue.shift(); continue; }
          if (verdict.context) next = { ...next, text: `${next.text}\n\n[Added by the user's hook]\n${verdict.context}` };
        }
        await this.#applyWantedModel();
        this.#take(next, true);
        this.#keptByModel = false;
        this.#noting = this.#heard().map((f) => f.text);
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
      if (stop === "end_turn") await this.#learn();
      // A stop hook may ask for one more round (never twice in a row: it is told when it already did).
      const ended = this.#o.hooks ? await this.#o.hooks.stop({ reason: stop, active: this.#stopHooked }).catch((): { notes: string[]; block?: string; said?: HookSaid[] } => ({ notes: [] })) : undefined;
      for (const note of ended?.notes ?? []) this.#emit({ ev: "notice", msg: note });
      this.#hookSaid(ended?.said);
      const again: Queued | undefined = ended?.block && stop === "end_turn" && !this.#stopHooked && !this.#closing.signal.aborted ? { text: `[A hook asks you to continue]\n${ended.block}`, images: [] } : undefined;
      this.#stopHooked = again !== undefined;
      const rest = stop === "end_turn" ? this.#queue.shift() ?? again ?? this.#woken() : undefined;
      if (!rest) { this.#busy = false; this.#dropQueue(); }
      this.#emit({ ev: "done", stop });
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
    for (const v of secretsIn(q.text)) this.#typed.add(v);
    if (startsTurn) { this.#codeOffer.begin(q.text); this.#asked = 0; this.#continued = false; this.#questioned = false; this.#questionEnd = "none"; this.#sinceAnswer = 0; this.#mcpAnswers.newTurn(); this.#outside.reset(); this.#outside.say(q.text); if (this.#o.outside === true) this.#outside.note(""); this.#turnQid = q.qid; this.#turnTokens = { in: 0, out: 0, calls: 0 }; }
    if (startsTurn && this.#kind === "agent") this.#checkpoint = attempt(() => this.#o.checkpoints?.begin(q.text || "Message", [this.#o.cwd, ...this.#written]));
    if (q.qid) {
      this.#emit({ ev: "user", qid: q.qid, text: q.text, ...(q.images.length ? { images: q.images.length } : {}), ...(q.files?.length ? { files: q.files } : {}), ...(q.from ? { from: q.from } : {}) });
      this.#emit({ ev: "taken", qid: q.qid });
    }
    this.#messages.push({ role: "user", content: asParts(q) });
  }

  /**
   * After a turn that ended well, the person's own words of the turn are looked through for lasting facts (see memory-extract.ts). Each
   * goes the way a note the agent keeps does: written, marked as the agent's own, or, in `ask` mode, kept for the person to accept.
   */
  async #learn(): Promise<void> {
    const how = this.#o.memoryExtract ?? "rules", paths = this.#o.memory;
    const said = this.#unlearned();
    this.#learnedTo = this.#messages.length;
    if (!said.length || !this.#learns()) return;
    try {
      // The model keeps notes itself with Remember: when it did, the turn's notes are its, and nothing is added beside them.
      const found = this.#keptByModel ? [] : extractByRules(said);
      if (how === "model" && !this.#keptByModel) for (const f of await extractByModel((system, user, signal) => this.#provider.complete(system, user, signal), said.map((m) => m.text))) if (!found.some((x) => x.text.toLowerCase() === f.text.toLowerCase())) found.push(f);
      const today = (this.#o.now?.() ?? new Date()).toISOString().slice(0, 10);
      let waiting = false;
      for (const f of found) {
        const result = keep(paths!, { action: "add", scope: f.scope, text: f.text }, { today, origin: "self", stage: this.#mode === "ask", source: "message", n: f.n ?? said.at(-1)!.n });
        if (result.startsWith("Remembered")) this.#emit({ ev: "notice", msg: `Saved to memory: ${f.text}` });
        else if (result.startsWith("Not kept yet")) waiting = true;
      }
      if (waiting) this.#emit(pendingEvent(paths!));
    } catch { /* a note that fills itself is a convenience: it never ends a turn badly */ }
  }

  /** Whether the person's words are looked through for notes here at all. */
  #learns(): boolean { return (this.#o.memoryExtract ?? "rules") !== "off" && this.#o.memory !== undefined && this.#kind !== "chat" && this.#mode !== "plan"; }

  /** What the person said since notes were last taken from it, message by message. */
  #unlearned(): { n: number; text: string }[] {
    const from = this.#learnedTo;
    return this.#messages.flatMap((m, at) => (at < from || m.role !== "user" ? [] : [{ n: at + 1, text: (typeof m.content === "string" ? m.content : (m.content ?? []).map((p) => (p.type === "text" ? p.text : "")).join(" ")).split("\n\n[Added by the user's hook]")[0]! }])).filter((m) => m.text.trim());
  }

  /** The notes the rules find in the person's words so far, for the model to know before it answers. */
  #heard(): Proposal[] { return this.#learns() ? extractByRules(this.#unlearned()) : []; }

  /** What the person wrote last. */
  #lastUserText(): string {
    const m = [...this.#messages].reverse().find((x) => x.role === "user");
    return !m ? "" : typeof m.content === "string" ? m.content : (m.content ?? []).map((p) => (p.type === "text" ? p.text : "")).join(" ");
  }

  /**
   * What a turn that is ending in words is told so that it goes on, if anything: at most once per turn whatever the reason, and never when
   * the person stopped it or wrote to it, or in plan mode. The reasons, in order:
   * the model's own task list was left open (a model that wrote its plan and then asked for leave to start);
   * it put a question, got its answer (or was told nobody could answer), and called no tool afterwards: it offered to do what it was asked.
   */
  #unfinishedTurn(): string | undefined {
    if (this.#continued || this.#cancelled || this.#mode === "plan" || this.#queue.length) return undefined;
    if (!this.#questioned && this.#todos.some((e) => e.status !== "completed")) return TODO_OPEN;
    if (this.#questionEnd !== "none" && this.#sinceAnswer === 0) return this.#questionEnd === "answered" ? ANSWERED : NOBODY_NOTE;
    return undefined;
  }

  async #steps(): Promise<void> {
    if (this.#loading.length) await Promise.all(this.#loading.splice(0));
    await this.#o.media?.refresh();
    for (let step = 0; step < this.#o.maxSteps; step++) {
      if (this.#cancelled) return;
      if (shouldCompact(this.#lastContext, this.#window)) await this.#compact();
      if (this.#cancelled) return;

      const small = this.#small;
      const skills = modelSkills(attempt(() => this.#o.skills?.()) ?? []);
      for (const t of offeredIn(this.#on, { small, jobs: this.#jobs.running, chat: this.#kind === "chat", typable: this.#jobs.typable, skills: skills.length, recall: (this.#o.recall?.recent(1).length ?? 0) > 0, memory: this.#o.memory !== undefined, schedule: this.#o.schedule !== undefined, skillBook: this.#o.skillBook !== undefined, computer: this.#computer !== undefined, code: this.#codeOffer.offered })) this.#offered.add(t.name);
      // The ones that are not offered are named in the prompt, and a call to one of them is run, not refused: the words that bring a tool
      // in (the web, a helper) are a guess about the request, and a guess can be wrong.
      const allowedNow = (t: Tool): boolean => this.#mode !== "plan" || t.readOnly || t.inPlan === true;
      const tools = inMode(this.#mode, this.#on.filter((t) => this.#offered.has(t.name)));
      const news = this.#jobs.news();
      const finished = news.flatMap(jobLines);
      // Named only where they can work: earlier conversations, and skills the agent may change, exist only in some places.
      const usable = (t: Tool): boolean => (t.name === "Recall" ? this.#o.recall !== undefined : t.name === "Remember" ? this.#o.memory !== undefined : t.name === "SkillManage" ? this.#o.skillBook !== undefined && this.#kind !== "chat" : t.name === "Schedule" ? this.#o.schedule !== undefined : t.name === COMPUTER_TOOL ? this.#computer !== undefined : t.name === "Browser" ? browserHere() : true);
      const also = this.#on.filter((t) => EXTRA.has(t.name) && usable(t) && allowedNow(t) && !tools.some((o) => o.name === t.name)).map((t) => t.name);
      try { await this.#o.prepare?.({ userText: this.#lastUserText() }); } catch { /* the notes fall back to words */ }
      const instructions = attempt(() => this.#o.instructions?.({ userText: this.#lastUserText() }));
      const written = new TextToolCalls(Object.fromEntries(tools.map((t) => [t.name, t.parameters as { properties?: Record<string, { type?: string }> }])), `text${this.#messages.length}_`);
      let thinkingSince: number | undefined;
      const endThought = (): void => { if (thinkingSince !== undefined) { this.#emit({ ev: "thought_end", ms: Date.now() - thinkingSince }); thinkingSince = undefined; } };
      const said = (text: string): void => { if (text) { endThought(); this.#emit({ ev: "text", text }); } };
      const ask = (effort: Effort | undefined): Promise<ModelReply> => this.#provider.stream(
        {
          system: systemPrompt({ cwd: this.#o.cwd, platform: process.platform, date: (this.#o.now?.() ?? new Date()).toISOString().slice(0, 10), ...(this.#persona ? { persona: this.#persona } : {}), ...(this.#noting.length && !this.#keptByModel ? { noted: this.#noting } : {}), ...(this.#reference ? { reference: this.#reference } : {}), tools: tools.map((t) => t.name), ...(also.length ? { also } : {}), ...(finished.length ? { finished } : {}), ...(instructions ? { instructions } : {}), ...(skills.length ? { skills: skillsPrompt(skills, small)! } : {}), small, ...(this.#kind === "chat" ? { kind: "chat" as const, sandboxed: this.#o.sandboxed === true } : {}) }, this.#mode) + (this.#noTools.has(this.#model ?? "") ? `\n\n${toolsInPrompt(tools)}` : ""),
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
        else {
          const note = this.#unfinishedTurn();
          if (note) { this.#continued = true; this.#messages.push({ role: "user", content: note }); continue; }
        }
        return;
      }
      if (this.#mode === "plan" && this.#presentPlan(reply)) return;
      this.#sinceTodo++;
      this.#sinceAnswer += reply.calls.length;

      // Helpers (and other tools that only read) asked for in the same step run side by side; anything that may change something runs alone and in order, because it may need an answer from the person.
      const writesLater = (c: ToolCall): boolean => { // a helper allowed to change things must not run beside another one
        if (c.name !== AGENT_TOOL_NAME || (this.#mode !== "auto" && this.#mode !== "bypass")) return false;
        const named = parseLenient(c.arguments)?.agent;
        return typeof named === "string" && !!this.#o.agents?.find((d) => d.name === named)?.tools;
      };
      const together = reply.calls.length > 1 && reply.calls.every((c) => { const t = tools.find((x) => x.name === c.name); return t?.readOnly === true && !writesLater(c); });
      if (together) {
        const outputs = await Promise.all(reply.calls.map((call) => (this.#cancelled ? "[interrupted]" : this.#runTool(call, tools))));
        reply.calls.forEach((call, i) => this.#answer(call, outputs[i]!));
      } else {
        // The ones that wait for their turn are shown as waiting; any that never get it (the turn was stopped) are shown as skipped.
        for (const call of reply.calls.slice(1)) { const input = parseLenient(call.arguments); this.#emit({ ev: "tool", id: call.id, name: call.name, status: "running", queued: true, ...(input ? { input: this.#shown(input) } : {}) }); }
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
          this.#answer(call, output);
        }
      }
      const note = this.#codeOffer.note();
      const last = this.#messages.at(-1);
      if (note && last?.role === "tool" && this.#mode !== "plan" && this.#on.some((t) => t.name === EXECUTE_CODE_TOOL)) last.content = `${last.content}\n${note}`;
      this.#showPictures();
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

  /** Tells the notification hooks that the agent waits for the person. */
  #notify(kind: "approval" | "question", message: string): void {
    void this.#o.hooks?.notify?.({ kind, message }).then((r) => { for (const note of r.notes) this.#emit({ ev: "notice", msg: note }); }).catch(() => undefined);
  }

  /** Asks the person to allow something: through this engine's own window, or, for a helper, through the engine that started it. */
  #approve(ask: ApprovalAsk): Promise<ApprovalAnswer> {
    if (this.#o.escalate) return this.#o.escalate(ask);
    const { id, answer } = this.#approvals.open();
    this.#emit({ ev: "approval", id, ...ask });
    this.#notify("approval", ask.title);
    return answer;
  }

  /** Whether a person can answer a question now. */
  #canAsk(): boolean { return !this.#o.noQuestions && !!attempt(() => this.#o.attended?.()); }
  /** The screen's helper asks before it uses an application: the person's answer is once, for the application, or no. Where nobody can be asked it is no. */
  async #consent(ask: ScreenAsk, tool: string): Promise<"once" | "app" | "no"> {
    if (this.#o.noQuestions && !this.#o.escalate) return "no";
    const lines = ask.lines.map((l) => this.#vault.hide(l).text);
    const given = await this.#approve({ title: `Computer: ${ask.about} ${ask.app}`, options: approvalOptions(ask.app), tool, screen: { ...ask, lines } });
    return given.optionId === ALLOW ? "once" : given.optionId === ALLOW_ALWAYS ? "app" : "no";
  }

  /** The Ask tool: the questions go to the person's window and wait; when nobody can answer, the model is told so and goes on. */
  async #askPerson(questions: QuestionItem[], signal: AbortSignal, tool: string): Promise<string> {
    this.#questioned = true;
    this.#sinceAnswer = 0;
    this.#questionEnd = "nobody";
    if (!this.#canAsk()) return NOBODY_ANSWERS;
    if (this.#asked >= MOST_QUESTIONS_PER_TURN) return "You have asked enough in this turn. Decide yourself, say what you assumed, and go on.";
    this.#asked++;
    const given = await this.#question(questions, signal, tool);
    if (given) { this.#questionEnd = "answered"; return answersText(questions, given); }
    return signal.aborted ? "[interrupted]" : `No answer came in time. ${NOBODY_ANSWERS}`;
  }

  /** Puts the questions to the person and waits for the answers: none when no answer came (no time, or it was stopped). */
  async #question(questions: QuestionItem[], signal: AbortSignal, tool: string): Promise<string[][] | undefined> {
    const { id, answer } = this.#questions.open();
    this.#emit({ ev: "question", id, questions, tool });
    this.#notify("question", questions[0]?.question ?? "The agent has a question");
    const wait = this.#o.askWaitMs ?? DEFAULT_ASK_WAIT_S * 1000;
    const timer = wait > 0 ? setTimeout(() => { if (!tool.startsWith("mcp:")) this.#expired.set(id, questions); for (const old of [...this.#expired.keys()].slice(0, -20)) this.#expired.delete(old); this.#questions.close(id); }, wait) : undefined;
    const stop = (): void => this.#questions.close(id);
    signal.addEventListener("abort", stop, { once: true });
    try { return await answer; }
    finally { clearTimeout(timer); signal.removeEventListener("abort", stop); }
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
  /** The answer of a tool call joins the conversation. A result for the model only replaces the one before it: a capture is stale as soon as the next is taken. */
  #answer(call: ToolCall, output: string): void {
    const note = this.#notes.get(call.id);
    const kind = this.#kinds.get(call.id) ?? "";
    if (note) this.#forgetCaptures(kind);
    const message: Message = { role: "tool", toolCallId: call.id, content: this.#toolMessage(output, call.name) };
    this.#messages.push(message);
    if (note) { this.#keptOut.set(message, note); this.#keptKind.set(message, kind); }
  }

  #forgetCaptures(kind: string): void {
    for (const [message, note] of this.#keptOut) {
      if ((this.#keptKind.get(message) ?? "") !== kind) continue;
      const at = this.#messages.indexOf(message);
      if (at >= 0) this.#messages[at] = { ...message, content: note };
      this.#keptOut.delete(message);
      this.#keptKind.delete(message);
    }
  }

  /** The pictures tools gave, as one message after the step's answers; those of a result for the model only are a message of their own. */
  #showPictures(): void {
    const all = this.#pictures.splice(0);
    for (const own of [false, true]) {
      const group = all.filter((p) => this.#notes.has(p.call) === own);
      if (!group.length) continue;
      const message: Message = { role: "user", content: [{ type: "text", text: "The picture from the tool result above:" }, ...group.map((p) => p.part)] };
      this.#messages.push(message);
      if (own) { this.#keptOut.set(message, [...new Set(group.map((p) => this.#notes.get(p.call)!))].join(" ")); this.#keptKind.set(message, this.#kinds.get(group[0]!.call) ?? ""); }
    }
    this.#notes.clear();
    this.#kinds.clear();
  }

  #toolMessage(output: string, tool: string): string {
    this.#codeOffer.count(tool, output);
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
  #relayApproval(ask: ApprovalAsk, parent: string): Promise<ApprovalAnswer> {
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
    const handed: Promise<void> = this.#inSlot(() => this.#helper(parent, task, def, writes, own.signal, false), true).then((result) => {
      this.#background.delete(id);
      this.#helpers.delete(handed);
      if (this.#closing.signal.aborted) return;
      this.#emit({ ev: "notice", msg: `A helper finished: ${task.description || task.prompt.slice(0, 60)}` });
      this.#prompt({ cmd: "prompt", text: `[Helper ${id} finished: ${task.description || task.prompt.slice(0, 60)}]\n${result}` });
    });
    this.#helpers.add(handed);
    return `Helper ${id} started in the background. Its answer arrives as a message when it ends; go on with other work.`;
  }

  async #helper(parent: string, task: { description: string; prompt: string; agent?: string }, def: AgentDef | undefined, writes: boolean, signal: AbortSignal, shown: boolean): Promise<string> {
    let answer = "";
    let steps = 0;
    const limits = this.#o.helperLimits ?? {};
    const copy = writes && def?.isolation === "worktree" ? await isolate(this.#o.cwd) : undefined;
    if (copy && "error" in copy) return `Error: ${copy.error}`;
    const allowed = def?.tools ? this.#on.filter((t) => def.tools!.includes(t.name) && !NOT_FOR_HELPERS.has(t.name) && (writes || t.readOnly)) : this.#on.filter((t) => t.readOnly && !NOT_FOR_HELPERS.has(t.name));
    const own = new AbortController();
    let late = false;
    const timer = setTimeout(() => { late = true; own.abort(); }, (limits.seconds ?? HELPER_SECONDS) * 1000);
    const helper = new Engine({
      home: this.#paths.home!,
      provider: this.#provider, cwd: copy?.dir ?? this.#o.cwd, window: this.#window, small: this.#small, heartbeatMs: 0, maxSteps: limits.steps ?? HELPER_STEPS,
      allowPrivateNetwork: this.#o.allowPrivateNetwork, noQuestions: true,
      ...(this.#o.noQuestions ? {} : { escalate: (ask: ApprovalAsk) => this.#relayApproval(ask, parent) }),
      tools: allowed,
      ...(this.#o.rules ? { rules: this.#o.rules } : {}),
      ...(this.#o.hooks ? { hooks: this.#o.hooks } : {}),
      persona: `${this.#persona ? `${this.#persona}\n\n` : ""}${def ? `You are the helper "${def.name}". ${def.prompt}\n\n` : ""}${HELPER_RULE}`,
      ...(this.#o.instructions ? { instructions: this.#o.instructions } : {}),
      ...(this.#o.search ? { search: this.#o.search } : {}),
      ...(this.#o.webProxy ? { webProxy: this.#o.webProxy } : {}),
      ...(this.#o.media ? { media: this.#o.media } : {}),
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
    const known = this.#on.find((t) => t.name === wanted) ?? this.#on.find((t) => squash(t.name) === squash(wanted));
    return known && (this.#mode !== "plan" || known.readOnly || known.inPlan) ? known : undefined;
  }

  /**
   * What a script running as `parent` may call: whatever the model itself may call (the tools offered, and the ones the prompt names), each as its own
   * step shown under the script's and through every check a call of the model meets. Not the script tool itself: a script gets no reach the model lacks.
   */
  #within(parent: ToolCall, offered: Tool[]): NonNullable<ToolContext["call"]> {
    let n = 0;
    const reachable = [...offered, ...this.#on.filter((t) => EXTRA.has(t.name))].filter((t, i, all) => t.name !== EXECUTE_CODE_TOOL && all.findIndex((o) => o.name === t.name) === i && this.#toolFor(t.name, offered) === t);
    return async (name, args) => {
      if (!reachable.some((t) => t.name === name)) return { ok: false, text: `Error: a script cannot call ${name || "that"}. It can call: ${reachable.map((t) => t.name).join(", ")}.` };
      let failed = false;
      const text = await this.#runTool({ id: `${parent.id}.${++n}`, name, arguments: JSON.stringify(args) }, offered, { parent: parent.id, ended: (f) => { failed = f; } });
      return { ok: !failed, text };
    };
  }

  /**
   * Runs one tool call through every check there is. `nested` is a call made by a tool that is itself a program (a script): it is shown
   * under that tool's step, tells its caller how it ended, and is not cut to the window, since the script decides what reaches the model.
   */
  async #runTool(call: ToolCall, offered: Tool[], nested?: { parent: string; ended: (failed: boolean) => void }): Promise<string> {
    let t0 = Date.now();
    const emit = (e: EngineEvent): void => {
      if (nested && e.ev === "tool") { if (e.status !== "running") nested.ended(e.status === "error"); this.#emit({ ...e, parent: nested.parent }); } else this.#emit(e);
    };
    const fail = (message: string, outcome?: ToolOutcome): string => { emit({ ev: "tool", id: call.id, name: call.name, status: "error", output: message, startedAt: t0, ms: Date.now() - t0, ...(outcome ? { outcome } : {}) }); return message; };
    const tool = this.#toolFor(call.name, offered);
    const off = tool ? undefined : this.#tools.find((t) => !this.#on.includes(t) && (t.name === call.name || squash(t.name) === squash(call.name)));
    if (off) return fail(`Error: the tool ${off.name} is turned off by the person. Do not look for a way around it: say what you could not do.`);
    if (!tool) return fail(`Error: there is no tool "${call.name}". Use one of: ${offered.map((t) => t.name).join(", ")}${this.#mode === "plan" ? " (plan mode only allows reading)" : ""}.${offered.some((t) => t.name === "Bash") ? ' To run a command: Bash {"command": "ls -la"}' : ""}`);

    let args = parseLenient(call.arguments);
    if (!args) return fail(`Error: the arguments for ${call.name} must be a JSON object such as ${exampleArguments(tool.parameters)}. Send them again.`);
    const flaw = (a: Record<string, unknown>): string | undefined => {
      const missing = (Array.isArray(tool.parameters.required) ? (tool.parameters.required as string[]) : []).filter((k) => a[k] === undefined);
      if (missing.length) return `Error: ${tool.name} needs ${missing.join(", ")}: ${exampleArguments(tool.parameters)}. Send the call again with it.`;
      const bad = FILE_WRITERS.has(tool.name) ? this.#vault.restore(textOf(a)).unknown : [];
      return bad.length ? `Error: ${bad[0]} is not a value you can write: it stands for a secret you were not shown, or one this conversation does not know any more. To keep a value as it is, write the [hidden:N] mark that Read gave for it; otherwise ask the person for the value.` : undefined;
    };
    if (tool.fixArgs) args = tool.fixArgs(args);
    const problem = flaw(args);
    if (problem) return fail(problem);
    emit({ ev: "tool", id: call.id, name: tool.name, status: "running", input: this.#shown(args) });

    // Hooks come before the mode is applied: one that changes the input is judged on the changed call, and one can only stop the call or ask about it, never let it past the mode.
    let hookAsk: string | undefined, hookContext: string | undefined;
    if (this.#o.hooks) {
      const before = await this.#o.hooks.pre({ tool: tool.name, input: args }, this.#abort.signal).catch((): PreVerdict => ({ notes: [] }));
      for (const note of before.notes) this.#emit({ ev: "notice", msg: note });
      this.#hookSaid(before.said, call.id, tool.name);
      if (before.block) return fail(`Blocked by a hook: ${before.block}`, "blocked");
      if (before.updatedInput) {
        const changed = tool.fixArgs ? tool.fixArgs({ ...args, ...before.updatedInput }) : { ...args, ...before.updatedInput };
        const wrong = flaw(changed);
        if (wrong) return fail(`Blocked by a hook: it changed the input to something ${tool.name} cannot take. ${wrong}`, "blocked");
        args = changed;
        emit({ ev: "tool", id: call.id, name: tool.name, status: "running", input: this.#shown(args) });
      }
      hookAsk = before.ask;
      hookContext = before.context;
    }

    // What a mode means for this call is decided in one place for every engine.
    const judgedByMode = judge({ mode: this.#mode, tool, args, cwd: this.#o.cwd, paths: this.#paths, rules: this.#o.rules, allowed: this.#allowed, knownUrl: (u) => this.#knownUrl(u), readable: this.#readable(), outside: this.#outside, secrets: () => this.#secrets(), held: () => this.#held() });
    const judged: Judgement = hookAsk && judgedByMode.kind === "go" ? { kind: "ask", scope: approvalScope(tool.name, args, this.#o.cwd), strange: false } : judgedByMode;
    if (judged.kind === "stop") return fail(judged.message, "blocked");
    if (judged.kind === "ask") {
      const { scope, risk, strange } = judged;
      if (this.#o.noQuestions && !this.#o.escalate) return fail(`Blocked: this needs the person's say-so${risk ? ` (${risk.reason})` : ""}, and a helper cannot ask. Do not try again; say what you wanted to do.`, "blocked");
      {
        const change = approvalChange(tool.name, this.#shown(args));
        const asked = attempt(() => tool.asks?.(args!, { cwd: this.#o.cwd, ...(isConfined(this.#kind) || this.#o.outside ? { root: this.#o.cwd } : {}) }))?.upload;
        const upload = asked ? { ...asked, path: this.#vault.hide(asked.path).text } : undefined;
        // A command can be changed by the person before it is allowed.
        const editable = tool.name === "Bash" && typeof args.command === "string" ? this.#vault.hide(args.command).text : undefined;
        const given = await this.#approve({ title: this.#vault.hide(withOrigin(strange ? `Open an address that was not in your request: ${String(args.url)}` : attempt(() => tool.title(args!)) ?? `Run ${tool.name}`, judged.copied)).text, options: approvalOptions(scope.phrase, editable), tool: call.id, ...(upload ? { upload } : {}), ...(change ? { change } : {}), ...(risk ? { risk: risk.reason } : hookAsk ? { risk: `A hook asks first: ${hookAsk}` } : {}) });
        if (given.optionId === ALLOW_ALWAYS) for (const k of scope.keys ?? [scope.key]) this.#allowed.add(k);
        else if (given.optionId === EDIT && editable !== undefined && given.input?.trim()) {
          // What the person typed is held to the same limits as anything else, and shown as the step's new input.
          const typed = this.#vault.restore(given.input.trim());
          if (typed.unknown.length) return fail(`Not run: ${typed.unknown.join(", ")} stands for a secret that is not known any more. Read the file again for its mark, or give the value.`, "blocked");
          args = { ...args, command: typed.text };
          const again = hardBlock(tool.name, args, this.#o.cwd, this.#paths);
          if (again) return fail(`Blocked: ${again}. navvied never does this.`, "blocked");
          const rule = this.#o.rules?.check(tool.name, args);
          if (rule?.kind === "deny") return fail(`Blocked by the permission rule ${rule.rule}.`, "blocked");
          emit({ ev: "tool", id: call.id, name: tool.name, status: "running", input: this.#shown(args) });
        } else if (given.optionId !== ALLOW && given.optionId !== EDIT) {
          // A no may carry what the person wants instead: the model is told in their words (a secret they typed stays hidden), not only that it was refused.
          const said = given.input?.trim();
          return fail(said ? `Not run. The person said: ${this.#vault.hide(said).text}` : given.unasked ? "Not run: nobody could be asked, so it was refused." : "The user denied this action.", "denied");
        }
      }
    }
    if (this.#abort.signal.aborted) return fail("[interrupted]", "stopped");
    if (!tool.readOnly) this.#beforeWrite(tool.name, args);
    // How long it took is how long it ran, not how long the person took to answer.
    t0 = Date.now();

    // What a command prints is passed on a little at a time; how it ended is reported by the tool.
    let pending = "", sent = 0, timer: ReturnType<typeof setTimeout> | undefined;
    const flush = (): void => { timer = undefined; if (pending) { emit({ ev: "tool", id: call.id, name: tool.name, status: "running", live: pending }); pending = ""; } };
    // What a running command prints is made safe as it arrives, before it reaches an event.
    const safe = new Redactor();
    const live = (raw: string): void => { const chunk = safe.push(raw); if (!chunk || sent > LIVE_MOST) return; sent += chunk.length; pending += chunk; timer ??= setTimeout(flush, LIVE_EVERY_MS); };
    let meta: { denied?: Denial; code?: number | null; truncated?: boolean; timedOut?: boolean; background?: boolean; cached?: boolean; screen?: ScreenOutcome; picture?: PictureInfo; media?: MediaFile } = {};
    let output: string;
    try {
      this.#outside.record(tool.name, args, this.#o.cwd);
      const execute = (unconfined?: true): Promise<string> => tool.run(this.#restored(tool.name, args), { cwd: this.#o.cwd, home: this.#paths.home!, ...(isConfined(this.#kind) || this.#o.outside ? { root: this.#o.cwd } : {}), signal: this.#abort.signal, emit: (e) => { if (e.ev === "plan") { this.#todos = e.entries; this.#sinceTodo = 0; } this.#emit(e.ev === "plan" ? { ...e, ...(this.#turnQid ? { qid: this.#turnQid } : {}), tool: call.id } : e.ev === "browser" ? { ...e, tool: call.id } : e); }, ask: (q, s) => this.#askPerson(q, s, call.id), live, report: (m) => { meta = { ...meta, ...m }; }, allowPrivateNetwork: this.#o.allowPrivateNetwork, window: this.#window, shell: this.#shell, jobs: this.#jobs, env: ChildEnv.scrubbed(process.env, this.#o.env), credentials: () => ({ secrets: this.#secrets(), origins: this.#named() }), ...(this.#o.backend ? { backend: this.#o.backend } : {}), ...(this.#o.recall ? { recall: this.#o.recall } : {}), ...(this.#o.peers ? { peers: this.#o.peers } : {}), ...(this.#o.schedule ? { schedule: this.#o.schedule } : {}), ...(this.#o.search ? { search: this.#o.search } : {}), ...(this.#o.toolFolder ? { folder: this.#o.toolFolder } : {}), ...(this.#computer ? { computer: this.#computer, consent: (ask: ScreenAsk) => this.#consent(ask, call.id) } : {}), outside: (text) => this.#outside.note(text), ...(this.#o.media ? { media: this.#o.media } : {}), ...(this.#o.webProxy ? { webProxy: this.#o.webProxy } : {}), ...(this.#o.skills ? { skills: this.#o.skills } : {}), ...(this.#o.memory ? { memory: this.#o.memory } : {}), helper: (task, signal) => this.#delegate(call.id, task, signal), files: this.#files, show: (p) => { this.#pictures.push({ part: p, call: call.id }); }, keepOut: (note, kind) => { this.#notes.set(call.id, note); this.#kinds.set(call.id, kind ?? ""); }, ...(this.#vision !== undefined ? { vision: this.#vision } : {}), mode: this.#mode, ...(this.#outside.seen ? { untrusted: true } : {}), ...(this.#o.skillBook ? { skillBook: this.#o.skillBook } : {}), ...(this.#o.skillApproval ? { skillApproval: this.#o.skillApproval } : {}), call: this.#within(call, offered), keep: (key, make) => { let v = this.#kept.get(key); if (!v) { v = make(); this.#kept.set(key, v); } return v as ReturnType<typeof make>; }, sandbox: this.#sandbox, ...(unconfined ? { unconfined } : {}) });
      output = await execute();
      if (meta.denied && tool.name === "Bash") { const { denied, ...rest } = meta; meta = rest; output = await this.#afterSandbox(call.id, args, denied, output, execute); }
    } catch (e) { output = `Error: ${e instanceof Error ? e.message : String(e)}`; }
    clearTimeout(timer);
    flush();
    // Whatever a tool gave, no more than the window can spare reaches the model.
    if (tool.name === "Read" || tool.name === "Grep" || FILE_WRITERS.has(tool.name)) output = this.#unseen(output);
    else if (tool.name === COMPUTER_TOOL) output = this.#vault.hide(output).text;
    // A program that was given a secret the person typed (a password asked for in a form) may say it back; the model never reads it.
    else if (tool.fromOutside && this.#typed.size) output = this.#vault.hide(output, this.#secrets()).text;
    if (tool.name === "Read" || tool.name === "Grep") this.#outside.read(output);
    const media = meta.media && !this.#notes.has(call.id) ? this.#o.shelf?.keep(meta.media) : undefined;
    const note = this.#notes.get(call.id);
    if (!nested) output = withinBudget(tool.name, output, this.#window);
    // Text somebody else wrote is framed here, once, whatever tool brought it; an error is the tool's own words.
    if (tool.fromOutside) {
      if (!output.startsWith("Error:")) output = untrusted(sourceOf(tool.name), output);
      this.#outside.note(output);
    }
    const stopped = this.#abort.signal.aborted || output.endsWith("[interrupted]");
    const outcome: ToolOutcome | undefined = meta.timedOut ? "timeout" : stopped ? "stopped" : meta.background ? "background" : undefined;
    const failed = output.startsWith("Error:") || outcome === "timeout" || outcome === "stopped";
    if (tool.name === "Remember" && /^(Remembered|Replaced|Not kept yet|That is already remembered)/.test(output)) this.#keptByModel = true;
    emit({ ev: "tool", id: call.id, name: tool.name, status: failed ? "error" : "done", output: note ?? output, startedAt: t0, ms: Date.now() - t0, ...(meta.code !== undefined ? { code: meta.code } : {}), ...(meta.truncated ? { truncated: true as const } : {}), ...(meta.cached ? { cached: true as const } : {}), ...(meta.screen ? { screen: meta.screen } : {}), ...(meta.picture ? { picture: meta.picture } : {}), ...(media ? { media } : {}), ...(outcome ? { outcome } : {}) });
    if (this.#o.hooks) {
      const after = await this.#o.hooks.post({ tool: tool.name, input: args, output: note ?? output }, this.#abort.signal).catch((): { notes: string[]; context?: string; said?: HookSaid[] } => ({ notes: [] }));
      for (const note of after.notes) this.#emit({ ev: "notice", msg: note });
      this.#hookSaid(after.said, call.id, tool.name);
      hookContext = [hookContext, after.context].filter(Boolean).join("\n") || undefined;
    }
    return hookContext ? `${output}\n\n[Added by the user's hook]\n${hookContext}` : output;
  }

  /** What each hook decided, as events: which hook, about which step, and why (secrets the person typed are hidden). */
  #hookSaid(said: readonly HookSaid[] | undefined, step?: string, tool?: string): void {
    for (const s of said ?? []) this.#emit({ ev: "hook", event: s.event, decision: s.decision, hook: this.#vault.hide(s.hook).text, ...(s.source ? { source: s.source } : {}), ...(step ? { step } : {}), ...(tool ? { tool } : {}), ...(s.reason ? { reason: this.#vault.hide(s.reason).text } : {}) });
  }

  async #compact(manual = false, keep: number = KEEP_TAIL): Promise<boolean> {
    this.#emit({ ev: "phase", name: "compacting" });
    if (this.#o.hooks?.compact) for (const note of (await this.#o.hooks.compact({ manual }, this.#abort.signal).catch(() => ({ notes: [] as string[] }))).notes) this.#emit({ ev: "notice", msg: note });
    try {
      const next = await compactMessages(this.#messages, this.#provider, this.#abort.signal, keep, { retry: (info) => this.#emit({ ev: "retry", ...info }), hide: (t) => hideSecrets(t, this.#secrets()) });
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

  #save(): void { try { this.#o.store?.save(this.sessionId, this.#withoutSecrets(this.#keptOut.size ? this.#messages.map((m) => { const note = this.#keptOut.get(m); return note === undefined ? m : { ...m, content: note }; }) : this.#messages)); } catch { /* a full disk must not kill the turn */ } }

  /** What is kept of the conversation: the same messages with every secret this conversation knows as a mark, in what was said, in what was answered and in the arguments of every call. */
  #withoutSecrets(messages: readonly Message[]): Message[] {
    const secrets = this.#secrets(), key = secrets.join("\0");
    if (key !== this.#hiddenFor) { this.#hiddenFor = key; this.#hidden = new WeakMap(); }
    const hide = (t: string): string => this.#vault.hide(t, secrets).text;
    return messages.map((m) => {
      const known = this.#hidden.get(m);
      if (known) return known;
      const content = typeof m.content === "string" ? hide(m.content) : m.content?.map((p) => (p.type === "text" ? { ...p, text: hide(p.text) } : p));
      const toolCalls = m.toolCalls?.map((c) => ({ ...c, arguments: hideArguments(c.arguments, hide) }));
      const kept: Message = { ...m, ...(content !== undefined ? { content } : {}), ...(toolCalls ? { toolCalls } : {}) };
      this.#hidden.set(m, kept);
      return kept;
    });
  }

  /** The arguments of a call as a window or a log may show them: every secret in them is a mark, at any depth. */
  #shown(args: Record<string, unknown>): Record<string, unknown> {
    const secrets = this.#secrets();
    return hideIn(args, (t) => this.#vault.hide(t, secrets).text) as Record<string, unknown>;
  }

  /** Every secret this conversation knows: the keys of this computer, and what the person typed. */
  #secrets(): string[] { return [...new Set([...secretsNow(), ...this.#typed])].sort((a, b) => b.length - a.length); }

  /** The sites the person named in their messages (scheme, host, port): a login they gave goes to these and to no other. */
  #named(): string[] {
    const found = new Set<string>();
    for (const m of this.#messages) if (m.role === "user") for (const o of originsIn(typeof m.content === "string" ? m.content : (m.content ?? []).map((p) => (p.type === "text" ? p.text : "")).join(" "))) found.add(o);
    return [...found];
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

  /**
   * The sandbox stopped a command at `d.path`. By mode the person is asked to run that one command outside it, or it is run without asking (Bypass),
   * or not at all (Plan; Auto when the path is inside what the sandbox allows, which would be a fault of the sandbox and not something to ask about).
   * It is judged again as a call of its own: what is never done and what a rule denies stays so. The model is told what happened, in every case.
   */
  async #afterSandbox(id: string, args: Record<string, unknown>, d: Denial, first: string, execute: (unconfined: true) => Promise<string>): Promise<string> {
    const what = d.kind === "write" ? "write" : "open";
    const told = `the command was stopped by the sandbox: it tried to ${what} ${d.path}`;
    const again = judge({ mode: this.#mode, tool: { name: "Bash", readOnly: false }, args, cwd: this.#o.cwd, paths: this.#paths, rules: this.#o.rules, allowed: this.#allowed, knownUrl: (u) => this.#knownUrl(u), outside: this.#outside });
    if (again.kind === "stop") return `${first}\n[${told}. It may not run outside it either. ${again.message}]`;
    const key = `sandbox:${dirname(d.path)}`;
    const away = relative(this.#o.cwd, d.path).startsWith("..");
    const bypass = this.#mode === "bypass";
    let allowed = bypass || this.#allowed.has(key);
    if (!allowed) {
      const why = this.#mode === "plan" ? "Plan mode changes nothing, so it was not run outside the sandbox."
        : this.#mode === "auto" && !away ? "That place is inside what the sandbox allows, so this is a fault of the sandbox and nobody was asked. Try another way, or tell the person."
          : this.#o.noQuestions && !this.#o.escalate ? "Nobody can be asked here, so it was not run outside the sandbox."
            : undefined;
      if (why) return `${first}\n[${told}. ${why}]`;
      const command = this.#vault.hide(String(args.command ?? "")).text;
      const change = approvalChange("Bash", { command });
      const given = await this.#approve({ title: `Run outside the sandbox: ${command.slice(0, 300)}`, options: approvalOptions(`commands that ${what} ${dirname(d.path)} outside the sandbox`), tool: id, ...(change ? { change } : {}), risk: `The sandbox stopped it: it tried to ${what} ${d.path}.` });
      if (given.optionId === ALLOW_ALWAYS) this.#allowed.add(key);
      allowed = given.optionId === ALLOW || given.optionId === ALLOW_ALWAYS;
      if (!allowed) { const said = given.input?.trim(); return `${first}\n[${told}. ${given.unasked ? "Nobody could be asked to run it outside the sandbox, so it was refused" : "The person was asked to run it outside the sandbox and said no"}${said ? `: ${this.#vault.hide(said).text}` : ""}. Do not look for a way around it: use another place, or say what you could not do.]`; }
    }
    const output = await execute(true);
    return `${output}\n[ran outside the sandbox: ${told}; ${bypass ? "Bypass mode lets it" : "the person allowed it"}]`;
  }

  /** The skills that come with the project and are not accepted: held back, with their folders. */
  #held(): { name: string; dir: string }[] { return (attempt(() => this.#o.skills?.()) ?? []).filter((s) => !s.trusted); }

  /** The folders outside the project that the program keeps things in for the model: its long output, what was attached, its notes and the skills. */
  #readable(): string[] {
    const m = this.#o.memory;
    return [SPILL_DIR, this.#attachmentDir(), ...(m ? [m.project, ...(m.user ? [m.user] : [])] : []), ...(attempt(() => this.#o.skills?.()) ?? []).filter((s) => s.trusted).map((s) => s.dir)];
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
