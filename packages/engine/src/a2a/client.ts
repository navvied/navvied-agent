/**
 * Asking another agent: one `message/send` to the address the person configured, and, while the peer says it is still working, `tasks/get`
 * until it is done or the time is up. The peer is the person's own choice, so a private address is allowed; a redirect is never followed
 * (the address was checked as it stands), and an answer is read only up to a limit.
 */
import { newId, readTask, type TaskState } from "./wire.ts";

export interface PeerTarget {
  name: string;
  /** Where the JSON-RPC calls go. */
  url: string;
  /** The bearer token, read when it is needed (never kept in the configuration the model can see). */
  token?: () => string | undefined;
  /** How long to wait for the answer in all, in milliseconds. */
  timeoutMs: number;
}

export interface PeerAnswer { text: string; context?: string; state: TaskState }

export interface AskDeps {
  fetch: typeof fetch;
  signal: AbortSignal;
  /** Waits between two looks at a task; a test gives its own. */
  sleep?: (ms: number) => Promise<void>;
  /** The most of an answer that is read, in bytes. */
  maxBytes?: number;
}

const MOST_BYTES = 1_000_000;
const sleepFor = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** The words of a failure, free of the token and of anything the peer's page said. */
export class PeerError extends Error {}

async function readBounded(res: Response, most: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > most) { await reader.cancel(); throw new PeerError(`the answer is larger than ${Math.round(most / 1000)} KB, so it was not read`); }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

async function call(peer: PeerTarget, method: string, params: unknown, d: AskDeps, signal: AbortSignal): Promise<unknown> {
  const token = peer.token?.();
  let res: Response;
  try {
    res = await d.fetch(peer.url, {
      method: "POST",
      redirect: "manual",
      signal,
      headers: { "content-type": "application/json", accept: "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: newId("rpc"), method, params }),
    });
  } catch (e) {
    if (signal.aborted) throw e;
    throw new PeerError(`${peer.name} could not be reached (${e instanceof Error ? e.message.replaceAll(token ?? "\0", "") : "network error"})`);
  }
  if (res.status >= 300 && res.status < 400) throw new PeerError(`${peer.name} answered with a redirect, which is not followed. Set its address to the final one.`);
  if (res.status === 401 || res.status === 403) throw new PeerError(`${peer.name} did not accept the token (status ${res.status})`);
  if (res.status === 429) throw new PeerError(`${peer.name} says it has too many requests; try again later`);
  const body = await readBounded(res, d.maxBytes ?? MOST_BYTES);
  let json: { result?: unknown; error?: { message?: unknown } };
  try { json = JSON.parse(body) as typeof json; } catch { throw new PeerError(`${peer.name} did not answer in JSON (status ${res.status})`); }
  if (json.error) throw new PeerError(`${peer.name} refused: ${typeof json.error.message === "string" ? json.error.message.slice(0, 300) : "an error"}`);
  if (!res.ok) throw new PeerError(`${peer.name} answered with status ${res.status}`);
  return json.result;
}

/** Sends `text` to the peer and returns what it answered, once the task has reached an end (or needs something this program cannot give). */
export async function askPeer(peer: PeerTarget, text: string, context: string | undefined, d: AskDeps): Promise<PeerAnswer> {
  const timeout = AbortSignal.timeout(peer.timeoutMs);
  const signal = AbortSignal.any([d.signal, timeout]);
  const wait = d.sleep ?? sleepFor;
  let taskId: string | undefined;
  try {
    const sent = await call(peer, "message/send", {
      message: { kind: "message", role: "user", parts: [{ kind: "text", text }], messageId: newId("msg"), ...(context ? { contextId: context } : {}) },
      configuration: { blocking: true, acceptedOutputModes: ["text/plain"] },
    }, d, signal);
    let seen = readTask(sent);
    if (!seen) throw new PeerError(`${peer.name} answered, but not with a task or a message`);
    taskId = seen.id;
    for (let gap = 500; (seen.state === "submitted" || seen.state === "working") && seen.id; gap = Math.min(gap * 2, 3000)) {
      await wait(gap);
      if (signal.aborted) throw signal.reason;
      seen = readTask(await call(peer, "tasks/get", { id: seen.id }, d, signal)) ?? seen;
    }
    return { text: seen.text, ...(seen.context ? { context: seen.context } : {}), state: seen.state };
  } catch (e) {
    if (taskId && signal.aborted) void call(peer, "tasks/cancel", { id: taskId }, d, AbortSignal.timeout(3000)).catch(() => undefined);
    if (timeout.aborted && !d.signal.aborted) throw new PeerError(`${peer.name} did not answer within ${peer.timeoutMs / 1000} seconds`);
    throw e;
  }
}
