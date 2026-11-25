import type { FileState } from "./tools/file-state.ts";
import type { ShellState } from "./tools/shell-state.ts";
import type { Backend } from "./backend.ts";
import type { Jobs } from "./jobs.ts";
import type { MemoryPaths } from "./memory.ts";
import type { SkillInfo } from "./skills.ts";
import type { SkillBook } from "./skill-book.ts";
import type { EngineEvent, PermMode, QuestionItem } from "@navvied/protocol";

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

export interface ToolContext {
  /** Something a tool keeps for the rest of the conversation (a program it started): made the first time, closed when the conversation ends. */
  keep?: <T extends { close(): void }>(key: string, make: () => T) => T;
  /** What this conversation has read or written of files: the tools that change a file check it. */
  files?: FileState;
  /** Whether the model can see pictures (not set: not known). */
  vision?: boolean;
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
  report?: (meta: { code?: number | null; truncated?: boolean; timedOut?: boolean; background?: boolean; cached?: boolean }) => void;
  /** Runs another tool as if the model had called it: the same checks, approvals and secret hiding. For a tool that is a program calling tools. `ok` is false when the call was refused or failed. */
  call?: (name: string, args: Record<string, unknown>) => Promise<{ ok: boolean; text: string }>;
  /** Runs a research task in a helper of its own and returns what it found. */
  helper?: (task: { description: string; prompt: string; agent?: string; background?: boolean }, signal: AbortSignal) => Promise<string>;
  /** Asks the person the questions and returns what they answered (or why nobody did), as the model reads it. */
  ask?: (questions: QuestionItem[], signal: AbortSignal) => Promise<string>;
}

export interface Tool extends ToolSpec {
  /** Offered only when something says it is on (`toolOn`): a tool still being measured is never offered by default. */
  experimental?: true;
  /** Read-only tools never need approval and are the only ones offered in plan mode. */
  readOnly: boolean;
  /** Whether to offer this tool now. A small model is easily led astray by tools it does not need, so some are offered only when the conversation calls for them. */
  offeredWhen?(situation: { small: boolean; userText: string; jobs: number; /** Steps taken so far in this turn. */ steps?: number; /** A conversation, not work on a project. */ chat?: boolean; /** Running commands that can be typed to. */ typable?: number; skills?: number; /** Earlier conversations can be looked through. */ recall?: boolean }): boolean;
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
