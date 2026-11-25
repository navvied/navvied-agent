/**
 * The agent-to-agent protocol on the wire: the Agent Card, JSON-RPC over HTTP, the task and its states. The shape is A2A 0.3.0
 * (`kind` on every object, lower-case states, `message/send`). What a peer sends is read in 0.3.0 and 1.0 shapes alike (upper-case
 * states, `{task}` and `{message}` wrappers, parts without `kind`); what this program sends is 0.3.0.
 */

export const PROTOCOL_VERSION = "0.3.0";
export const CARD_PATH = "/.well-known/agent-card.json";
/** The path older peers read the card at. */
export const CARD_PATH_LEGACY = "/.well-known/agent.json";

export type TaskState = "submitted" | "working" | "input-required" | "completed" | "canceled" | "failed" | "rejected" | "auth-required" | "unknown";
export const FINAL_STATES: ReadonlySet<TaskState> = new Set(["completed", "canceled", "failed", "rejected"]);

export interface Part { kind: "text"; text: string }
export interface WireMessage { kind: "message"; role: "user" | "agent"; parts: Part[]; messageId: string; contextId?: string; taskId?: string }
export interface Artifact { artifactId: string; name?: string; parts: Part[] }
export interface Task {
  kind: "task";
  id: string;
  contextId: string;
  status: { state: TaskState; timestamp: string; message?: WireMessage };
  artifacts?: Artifact[];
}
export interface Skill { id: string; name: string; description: string; tags: string[] }
export interface AgentCard {
  protocolVersion: string;
  name: string;
  description: string;
  url: string;
  preferredTransport: "JSONRPC";
  version: string;
  capabilities: { streaming: boolean; pushNotifications: boolean; stateTransitionHistory: boolean };
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: Skill[];
  securitySchemes: Record<string, { type: "http"; scheme: "bearer"; description: string }>;
  security: Record<string, string[]>[];
}

/** JSON-RPC and A2A error codes. -32001 to -32005 are the protocol's own; the -3205x ones are this server's limits. */
export const ERR = {
  parse: -32700, request: -32600, method: -32601, params: -32602, internal: -32603,
  taskNotFound: -32001, notCancelable: -32002, pushUnsupported: -32003, unsupported: -32004,
  rate: -32051, busy: -32052, turns: -32053, tooLarge: -32054,
} as const;

export interface RpcError { code: number; message: string }
export const rpcResult = (id: unknown, result: unknown): { jsonrpc: "2.0"; id: unknown; result: unknown } => ({ jsonrpc: "2.0", id, result });
export const rpcError = (id: unknown, code: number, message: string): { jsonrpc: "2.0"; id: unknown; error: RpcError } => ({ jsonrpc: "2.0", id, error: { code, message } });

export const now = (at: number = Date.now()): string => new Date(at).toISOString();
export const newId = (prefix: string): string => `${prefix}-${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;

export const textMessage = (role: "user" | "agent", text: string, contextId?: string, taskId?: string): WireMessage => ({
  kind: "message", role, parts: [{ kind: "text", text }], messageId: newId("msg"), ...(contextId ? { contextId } : {}), ...(taskId ? { taskId } : {}),
});

/** A state in either spelling (`completed`, `TASK_STATE_COMPLETED`, `input_required`) as the one this program uses. */
export function stateOf(raw: unknown): TaskState {
  if (typeof raw !== "string") return "unknown";
  const s = raw.replace(/^TASK_STATE_/, "").toLowerCase().replaceAll("_", "-");
  if (s === "cancelled") return "canceled";
  const known: readonly TaskState[] = ["submitted", "working", "input-required", "completed", "canceled", "failed", "rejected", "auth-required"];
  return known.find((k) => k === s) ?? "unknown";
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The text of a message or an artifact: its text parts, whatever the version of the peer. Other kinds of part are said to be there and nothing more (a file or data is not read). */
export function textOf(thing: unknown): string {
  if (!isObject(thing) || !Array.isArray(thing.parts)) return "";
  const chunks: string[] = [];
  let other = 0;
  for (const p of thing.parts) {
    if (isObject(p) && typeof p.text === "string") chunks.push(p.text);
    else other++;
  }
  if (other) chunks.push(`[${other === 1 ? "1 part that is" : `${other} parts that are`} not text: not read]`);
  return chunks.join("\n").trim();
}

/** What a peer answered, in one shape: the task or message inside a 1.0 wrapper, or the object itself. */
export function unwrap(result: unknown): Record<string, unknown> | undefined {
  if (!isObject(result)) return undefined;
  if (isObject(result.task)) return result.task;
  if (isObject(result.message)) return result.message;
  return result;
}

/** The words of a finished or running task as one reader needs them: its state, its context, and what it says (the artifacts first, else the status message). */
export function readTask(raw: unknown): { id?: string; context?: string; state: TaskState; text: string } | undefined {
  const t = unwrap(raw);
  if (!t) return undefined;
  if (t.kind === "message" || (Array.isArray(t.parts) && !isObject(t.status))) {
    return { ...(typeof t.contextId === "string" ? { context: t.contextId } : {}), state: "completed", text: textOf(t) };
  }
  if (!isObject(t.status)) return undefined;
  const artifacts = Array.isArray(t.artifacts) ? t.artifacts.map(textOf).filter(Boolean).join("\n\n") : "";
  return {
    ...(typeof t.id === "string" ? { id: t.id } : {}),
    ...(typeof t.contextId === "string" ? { context: t.contextId } : {}),
    state: stateOf(t.status.state),
    text: artifacts || textOf(t.status.message),
  };
}

export interface CardInput { name: string; description: string; url: string; version: string; skills: Skill[] }

/** The card another agent reads first. It holds no secret and no private detail: the name, what this agent can do, and which sign-in it wants. */
export const agentCard = (i: CardInput): AgentCard => ({
  protocolVersion: PROTOCOL_VERSION,
  name: i.name,
  description: i.description,
  url: i.url,
  preferredTransport: "JSONRPC",
  version: i.version,
  capabilities: { streaming: true, pushNotifications: false, stateTransitionHistory: false },
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/plain"],
  skills: i.skills.length ? i.skills : [{ id: "general", name: "General", description: "Answers questions in plain text.", tags: [] }],
  securitySchemes: { bearer: { type: "http", scheme: "bearer", description: "A token made for you on this computer." } },
  security: [{ bearer: [] }],
});
