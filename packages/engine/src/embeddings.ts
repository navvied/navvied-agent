/**
 * Search by meaning, through what the person already runs: a server that turns text into vectors (a local llama-server started with an
 * embedding model and `--embeddings`, Ollama, or any service that speaks the chat-completions style `/embeddings` call, on the person's own key). Nothing
 * is built in and nothing is sent anywhere the person did not name; with no server set up this module is never used. Plain HTTP, no library.
 */
import { redact, secretsIn } from "./redact.ts";

export interface EmbeddingConfig {
  /** The server's address: `http://127.0.0.1:8080/v1` for the chat shape, `http://127.0.0.1:11434` for Ollama. */
  baseUrl: string;
  model: string;
  api: "chat" | "ollama";
  /** The person's own key for that server, when it wants one. Never logged, never in an error. */
  apiKey?: string;
}

/** A text longer than this is cut: a vector is of a passage, and a server has a window. */
export const EMBED_TEXT_MAX = 1_500;
/** Texts sent in one call. */
export const EMBED_BATCH = 32;
const TIMEOUT_MS = 8_000;

/** A reason in plain words for why meaning search is not working; it never holds the key, the address or what the server answered. */
export class EmbeddingError extends Error {}

/** The text as it may leave this computer: secrets hidden, passwords said in words too, cut to the size a passage may have. */
export function forEmbedding(text: string): string {
  let safe = redact(text);
  for (const v of secretsIn(safe)) safe = safe.split(v).join("[hidden]");
  return safe.replace(/\s+/g, " ").trim().slice(0, EMBED_TEXT_MAX);
}

/** The vector with length 1, so that how alike two texts are is the dot product. */
function unit(v: readonly number[]): Float32Array {
  const out = Float32Array.from(v);
  let sum = 0;
  for (const x of out) sum += x * x;
  const length = Math.sqrt(sum) || 1;
  for (let i = 0; i < out.length; i++) out[i]! /= length;
  return out;
}

export const dot = (a: Float32Array, b: Float32Array): number => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!; return s; };

const endpoint = (c: EmbeddingConfig): string => `${c.baseUrl.replace(/\/+$/, "")}${c.api === "ollama" ? "/api/embed" : "/embeddings"}`;

async function call(config: EmbeddingConfig, texts: readonly string[], signal: AbortSignal | undefined, fetcher: typeof fetch): Promise<Float32Array[]> {
  let res: Response;
  try {
    res = await fetcher(endpoint(config), {
      method: "POST",
      headers: { "content-type": "application/json", ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}) },
      body: JSON.stringify({ model: config.model, input: texts }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new EmbeddingError((e as Error).name === "TimeoutError" || (e as Error).name === "AbortError" ? "the embeddings server did not answer in time" : "the embeddings server could not be reached");
  }
  if (!res.ok) throw new EmbeddingError(res.status === 401 || res.status === 403 ? "the embeddings server did not accept the key" : `the embeddings server answered with status ${res.status}`);
  let body: unknown;
  try { body = await res.json(); } catch { throw new EmbeddingError("the embeddings server answered in a form that is not understood"); }
  const rows = config.api === "ollama"
    ? (body as { embeddings?: unknown }).embeddings
    : ((body as { data?: { index?: number; embedding?: unknown }[] }).data ?? []).slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((d) => d.embedding);
  const ok = Array.isArray(rows) && rows.length === texts.length && rows.every((r) => Array.isArray(r) && r.length > 0 && r.every((x) => typeof x === "number" && Number.isFinite(x)));
  if (!ok) throw new EmbeddingError("the embeddings server answered in a form that is not understood");
  const vectors = (rows as number[][]).map(unit);
  if (vectors.some((v) => v.length !== vectors[0]!.length)) throw new EmbeddingError("the embeddings server answered with vectors of different sizes");
  return vectors;
}

/** The vectors of these texts, in order, as unit vectors; secrets are hidden before anything is sent. Throws an `EmbeddingError` with a plain reason. */
export async function embed(config: EmbeddingConfig, texts: readonly string[], signal?: AbortSignal, fetcher: typeof fetch = fetch): Promise<Float32Array[]> {
  const safe = texts.map(forEmbedding);
  const out: Float32Array[] = [];
  for (let at = 0; at < safe.length; at += EMBED_BATCH) out.push(...(await call(config, safe.slice(at, at + EMBED_BATCH), signal, fetcher)));
  return out;
}

/**
 * Several orderings of the same things as one: each thing scores 1 / (60 + its place) in every list that has it, and the sums are the order.
 * It needs no common scale between a word match and a likeness of meaning, and a thing that both lists like comes first.
 */
export function fuse(lists: readonly (readonly string[])[]): Map<string, number> {
  const score = new Map<string, number>();
  for (const list of lists) list.forEach((key, place) => score.set(key, (score.get(key) ?? 0) + 1 / (60 + place)));
  return score;
}
