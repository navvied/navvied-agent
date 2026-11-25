import type { FileState } from "./tools/file-state.ts";
import type { ShellState } from "./tools/shell-state.ts";
import type { Backend } from "./backend.ts";
import type { Jobs } from "./jobs.ts";
import type { MemoryPaths } from "./memory.ts";
import type { SkillInfo } from "./skills.ts";
import type { SkillBook } from "./skill-book.ts";
import type { Media } from "./media/media.ts";
import type { Need } from "./media/types.ts";
import type { EngineEvent, PermMode, QuestionItem, ScreenOutcome } from "@navvied/protocol";
import type { Timing } from "./schedule-when.ts";
import type { PeerAnswer } from "./a2a/client.ts";

export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall { id: string; name: string; /** JSON text, exactly as the model produced it. */ arguments: string }
export type Part = { type: "text"; text: string } | { type: "image"; mime: string; data: string } | { type: "file"; name: string; mime: string; data: string };

/** One conversation message. Plain data: it is saved and reloaded as JSON. */
export interface Message {
  role: Role;
  content?: string | Part[];
  toolCalls?: ToolCall[];
  toolCallId?: string;
}

export type JsonSchema = Record<string, unknown>;
/** The earlier conversations of the person, as a tool may look through them. */
export interface Recall {
  /** The conversations that match, best first: the message that matched is `n` (1-based) in the conversation. */
  search(query: string, limit: number): { id: string; title: string; snippet: string; updated: number; n: number }[];
  /** Every message of one conversation, in order. */
  read(id: string): { k: string; text: string }[] | undefined;
  /** The conversations most recently worked on. */
  recent(limit: number): { id: string; title: string; updated: number }[];
}
/** One job as the Schedule tool shows it. `when` is its timing in words; times are ms since the epoch. */
export interface ScheduleJob { id: string; name: string; prompt: string; when: string; tz?: string; mode: "plan" | "auto"; enabled: boolean; next?: number; /** How the last run ended; `missed` is a run that never started. */ lastOutcome?: "ok" | "failed" | "missed" | "running"; lastAt?: number }
/** One run of a job. `due` is set when the run started late, and says when it was due. */
export interface ScheduleRun { at: number; outcome: "ok" | "failed" | "missed" | "running"; due?: number; note?: string }
export interface ScheduleInput { name: string; prompt: string; timing: Timing; tz?: string; mode: "plan" | "auto" }
/**
 * Where the Schedule tool keeps its jobs: a computer's own list, or a hosted session's cloud jobs. A refusal comes back as one plain sentence,
 * never thrown.
 */
export interface ScheduleBackend {
  /** Said after a job is made: where and when it runs. */
  about: string;
  /** The clock (injected, so tests need no waiting). */
  now(): number;
  /** The most jobs it keeps; none when the service decides and says so itself. */
  maxJobs?: number;
  /** False in a place that may only look (a job that is running). */
  canChange: boolean;
  list(): Promise<ScheduleJob[] | string>;
  create(input: ScheduleInput): Promise<ScheduleJob | string>;
  update(id: string, change: Partial<ScheduleInput>): Promise<ScheduleJob | string>;
  setEnabled(id: string, enabled: boolean): Promise<ScheduleJob | string>;
  remove(id: string): Promise<true | string>;
  runs(id: string): Promise<ScheduleRun[] | string>;
}
export interface ToolSpec { name: string; description: string; parameters: JsonSchema }

export interface ModelRequest {
  system: string;
  messages: Message[];
  tools: ToolSpec[];
  effort?: string;
}

export interface ModelReply {
  content: string;
  calls: ToolCall[];
  finish: string;
  usage?: { prompt: number; completion: number };
}

/** A call to the model is about to be made again: why, which try comes next out of how many, and how long it waits first. */
export interface RetryInfo { reason: string; attempt: number; of: number; inSeconds: number }

export interface StreamHandlers {
  text(delta: string): void;
  thought(delta: string): void;
  /** The model named a tool — its arguments may still be streaming. */
  toolStarted(id: string, name: string): void;
  /** Said before each wait that comes before another try. */
  retry?(info: RetryInfo): void;
}

export interface Provider {
  /** The service reads a PDF given as a file part, so the original goes along with its text. */
  readonly readsPdf?: boolean;
  /** Calls to it are made again by itself when that is worth doing (see `RetryProvider`), so nobody puts it inside another loop. */
  readonly retries?: true;
  stream(req: ModelRequest, signal: AbortSignal, on: StreamHandlers): Promise<ModelReply>;
  complete(system: string, user: string, signal: AbortSignal, on?: { retry?: (info: RetryInfo) => void }): Promise<string>;
}

/** The address (up to and including `/v1/web`) and the token of the service that fetches and searches the web for a session. */
export interface WebProxy { url: string; token: string }

/** One step on a person's screen, as the engine sends it to the helper that owns the screen (the desktop app's host). */
export interface ComputerCall {
  action: "capture" | "click" | "type" | "key" | "scroll" | "list" | "wait" | "drag";
  app?: string;
  /** An element number from the last capture. */
  target?: number;
  text?: string;
  /** For `key`, a combination such as `cmd+s`. For `click`, `drag` and `scroll`, the keys held down while it happens (`shift`, `cmd+shift`). */
  keys?: string;
  /** Pixels, only when the capture had no number for the place. For `drag`, where it starts. */
  x?: number;
  y?: number;
  /** For `click`: sent only when it is not the left button. */
  button?: "right" | "middle";
  /** For `click`: sent only as 2 (a double click). */
  count?: 2;
  /** For `drag`: the element number it ends on (with `target` as the start), or the pixels (with `x` and `y` as the start). */
  to?: number;
  to_x?: number;
  to_y?: number;
  /** For `scroll`: always sent, with `amount` as wheel ticks, 1 to 50. */
  direction?: "up" | "down" | "left" | "right";
  amount?: number;
  /** For `wait`, when given: 0 to 30. Without it, the helper's own short pause. */
  seconds?: number;
  /** For `capture`: `ax` (numbered accessibility tree, no image), `som` (screenshot with numbers, plus the tree) or `vision`. The engine never asks for an image of a model that cannot see. */
  mode?: "ax" | "som" | "vision";
}

/** The closed reasons a helper refuses; the engine adds `stale_target` of its own. */
export type ComputerCode = "background_unavailable" | "background_occluded" | "background_uipi_blocked" | "human_has_control" | "input_target_mismatch" | "permission_missing" | "blocked_by_policy";

export interface ComputerResult {
  /** `unverified`: the input was sent and cannot be proven to have landed. */
  verdict: "delivered" | "unverified" | "refused";
  code?: ComputerCode;
  /** What is missing, for `permission_missing`. */
  which?: string;
  /** The exact next step, for a refusal or an unverified input. */
  next?: string;
  /** The application the step was about; the engine fills it from the call when the helper does not say. */
  app?: string;
  /** For `capture` and `list`: numbered lines such as `12 button "Save"`. */
  tree?: string;
  image?: { mime: string; data: string };
}

/**
 * What drives the screen. It belongs to the machine that has the screen, and it owns every approval, hard block and indicator: the engine
 * only sends an action and relays the answer. A call that throws or is cut off has an outcome nobody knows.
 */
export interface ComputerHelper {
  call(c: ComputerCall, signal?: AbortSignal): Promise<ComputerResult>;
}

export interface ToolContext {
  /** A tool that frames its own text from outside says so here, so the rest of the turn is judged knowing it was read. */
  outside?: (text: string) => void;
  /** The helper that drives this computer's screen (when computer use is on). */
  computer?: ComputerHelper;
  /** This result is kept out of the saved conversation, the step's card and the hooks: they get `note` instead, and any picture shown with it is dropped the same way. The model has the full text for the rest of the turn, until a newer one replaces it. */
  keepOut?: (note: string) => void;
  /** Something a tool keeps for the rest of the conversation (a program it started): made the first time, closed when the conversation ends. */
  keep?: <T extends { close(): void }>(key: string, make: () => T) => T;
  /** What this conversation has read or written of files: the tools that change a file check it. */
  files?: FileState;
  /** Whether the model can see pictures (not set: not known). */
  vision?: boolean;
  /** What the person gave this conversation: the secrets they typed (and any saved login), and the origins (scheme, host, port) of the sites they named. A secret goes only to a page on one of those origins. */
  credentials?: () => { secrets: readonly string[]; origins: readonly string[] };
  /** Gives the model a picture with the result of the tool. */
  show?: (part: Part) => void;
  /** What this conversation's commands remember between calls (the folder, the exports). */
  shell?: ShellState;
  /** The model's context window in tokens, for tools that size what they return to it. */
  window?: number;
  cwd: string;
  /** When set, the tools that read or write files work only inside this folder (a chat's scratch folder). */
  root?: string;
  /** Aborted when the user cancels the turn: stop work and return promptly. */
  signal: AbortSignal;
  emit: (e: EngineEvent) => void;
  /** Allow web fetches to private/loopback addresses (off by default). */
  allowPrivateNetwork: boolean;
  /** Commands that keep running after the turn that started them. */
  jobs: Jobs;
  /** What a command starts with: this program's environment without the keys it uses itself (see child-env.ts). */
  env?: NodeJS.ProcessEnv;
  /** Where Bash runs its commands (on this computer when it is not set). */
  backend?: Backend;
  /** The person's earlier conversations, for the Recall tool. */
  recall?: Recall;
  /** A search server to use instead of the public search page. */
  search?: { url?: string; /** The keyless search sites to try, in this order (see web-search-backends.ts); the default is all of them. */ order?: string[]; /** Where navvied's own search is (for a computer whose network blocks the public pages), and this computer's account token when it has one. */ navvied?: () => { server: string; token?: string } | undefined };
  /** Where a session with no network of its own reaches the web: WebFetch and WebSearch ask it, with the token, instead of going out. */
  webProxy?: WebProxy;
  /** Where the Schedule tool keeps jobs. */
  schedule?: ScheduleBackend;
  /** What can hear, speak, draw or look at media in this conversation. */
  media?: Media;
  /** The skills in effect now. */
  skills?: () => SkillInfo[];
  /** Where the agent keeps notes for later. */
  memory?: MemoryPaths;
  /** The permission mode of the conversation now. */
  mode?: PermMode;
  /** This turn has read text from the web, so what the agent saves now may have been put in its head by a page. */
  untrusted?: boolean;
  /** How the agent makes and changes skills, and keeps the record of it. */
  skillBook?: SkillBook;
  /** `ask`: a change to a skill waits for the person; `auto` (default): it is made and can be undone. */
  skillApproval?: () => "ask" | "auto";
  /** What a command printed, as it prints (the engine passes it on, a little at a time). */
  live?: (chunk: string) => void;
  /** Facts about how the work ended, for the step's card: the exit code, that the output was cut, that it timed out, or that it went on as a job. */
  report?: (meta: { code?: number | null; truncated?: boolean; timedOut?: boolean; background?: boolean; cached?: boolean; /** How a step on the screen ended, for the card. */ screen?: ScreenOutcome }) => void;
  /** Runs another tool as if the model had called it: the same checks, approvals and secret hiding. For a tool that is a program calling tools. `ok` is false when the call was refused or failed. */
  call?: (name: string, args: Record<string, unknown>) => Promise<{ ok: boolean; text: string }>;
  /** Runs a research task in a helper of its own and returns what it found. */
  helper?: (task: { description: string; prompt: string; agent?: string; background?: boolean }, signal: AbortSignal) => Promise<string>;
  /** The other agents the person has set up to ask. */
  peers?: PeerBook;
  /** Asks the person the questions and returns what they answered (or why nobody did), as the model reads it. */
  ask?: (questions: QuestionItem[], signal: AbortSignal) => Promise<string>;
}

/** The agents this person set up to ask (see a2a/client.ts): their names, and how to ask one. */
export interface PeerBook {
  names: string[];
  ask(name: string, message: string, context: string | undefined, signal: AbortSignal): Promise<PeerAnswer>;
}

export interface Tool extends ToolSpec {
  /** Offered only when something says it is on (`toolOn`): a tool still being measured is never offered by default. */
  experimental?: true;
  /** The tool exists only where this is available (a provider of a kind of media); a computer without it is not offered the tool and a call to it is refused. */
  needs?: Need;
  /** Read-only tools never need approval and are the only ones offered in plan mode. */
  readOnly: boolean;
  /** Offered in plan mode though it may change things: the judge decides each call (only what it allows there is run). */
  inPlan?: true;
  /** Its results are text somebody else wrote (a page, a search, a connected service): the engine frames every result as information, not instructions, and the rest of the turn is judged knowing it was read. */
  fromOutside?: true;
  /** Its calls are asked about, even in Auto, once the turn has read text from outside: a tool that starts something for later or sends something away. */
  askAfterOutside?: true;
  /** Whether to offer this tool now. A small model is easily led astray by tools it does not need, so some are offered only when the conversation calls for them. */
  offeredWhen?(situation: { small: boolean; userText: string; jobs: number; /** Steps taken so far in this turn. */ steps?: number; /** A conversation, not work on a project. */ chat?: boolean; /** Running commands that can be typed to. */ typable?: number; skills?: number; /** Earlier conversations can be looked through. */ recall?: boolean; /** Notes can be kept. */ memory?: boolean; /** Jobs can be scheduled here. */ schedule?: boolean; /** Computer use is on. */ computer?: boolean; /** The turn has shown that a script would pay (see `code-offer.ts`). */ code?: boolean }): boolean;
  /** Puts the arguments a model wrote in other words into the ones this tool has, before they are checked. */
  fixArgs?(args: Record<string, unknown>): Record<string, unknown>;
  title(args: Record<string, unknown>): string;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}

export interface SessionStore {
  save(id: string, messages: Message[]): void;
  load(id: string): Message[] | null;
  /** The saved sessions, newest first, when the store can list them. */
  list?(): SessionSummary[];
}

export interface SessionSummary { id: string; title: string; updated: number; messages: number; project?: string }
