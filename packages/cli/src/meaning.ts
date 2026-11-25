import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { EmbeddingError, dot, embed, forEmbedding, fuse, type EmbeddingConfig } from "@navvied/engine";
import type { HistoryItem } from "@navvied/protocol";
import { embeddingConfig, type EmbeddingSettings } from "./meaning-config.ts";
import type { Found, SearchIndex } from "./search-index.ts";

/** Texts embedded in one go at most: a turn or a search never waits for more than two calls. */
const MOST_PER_CALL = 64;
/** The vectors kept for earlier messages; the oldest go first. A vector is about 4 bytes a number. */
const MOST_MESSAGE_VECTORS = 10_000;
/** Of the newest messages, how many a search looks through for ones that have no vector yet. */
const CATCH_UP_SCAN = 2_000;
/** A message is taken for the same meaning only when it is at least this like the question, and not far behind the best one. */
const LEAST_LIKE = 0.3;
const WITHIN_BEST = 0.2;

/** A vector kept as bytes. */
const toBlob = (v: Float32Array): Uint8Array => new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
const fromBlob = (b: Uint8Array): Float32Array => new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));

export interface MessageRef { id: string; n: number; text: string }

/** The path of the vectors that belong to a search index. */
export const vectorsFor = (indexPath: string): string => (indexPath === ":memory:" ? ":memory:" : indexPath.replace(/\.sqlite$/, "") + ".vectors.sqlite");

/**
 * Search by meaning through a server the person set up (see `meaning-config.ts`): notes and messages are turned into vectors when they
 * are written, kept next to the search index, and a question is compared with them by cosine. It never throws: when the server is
 * down, slow, refuses, or answers wrongly, the callers get nothing and `notice` says in one plain line why, so they fall back to words.
 * Everything sent is first made safe (`forEmbedding`); vectors made by another model, or of another size, are made again.
 */
export class Meaning {
  readonly #db: Database;
  readonly #config: EmbeddingConfig;
  readonly #fetch: typeof fetch;
  #why: string | undefined;

  constructor(config: EmbeddingConfig, path: string, fetcher: typeof fetch = fetch) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.#db = new Database(path, { create: true });
    this.#db.exec("PRAGMA journal_mode = WAL;");
    this.#db.exec("CREATE TABLE IF NOT EXISTS notes (h TEXT PRIMARY KEY, model TEXT NOT NULL, v BLOB NOT NULL)");
    this.#db.exec("CREATE TABLE IF NOT EXISTS msgs (session TEXT NOT NULL, n INTEGER NOT NULL, h TEXT NOT NULL, model TEXT NOT NULL, v BLOB NOT NULL, PRIMARY KEY (session, n))");
    this.#config = config;
    this.#fetch = fetcher;
  }

  /** One plain line for the model when meaning search is set up and its last try failed; nothing when it works or has not been tried. */
  notice(): string | undefined { return this.#why ? `Search by meaning is off right now (${this.#why}); these results are by words.` : undefined; }

  async #embed(texts: readonly string[], signal?: AbortSignal): Promise<Float32Array[] | undefined> {
    try {
      const out = await embed(this.#config, texts, signal, this.#fetch);
      this.#why = undefined;
      return out;
    } catch (e) {
      this.#why = e instanceof EmbeddingError ? e.message : "the embeddings server could not be used";
      return undefined;
    }
  }

  /** How alike each note is to the request, from 0 to 1; a note that has no vector yet is embedded (a few at a time) and kept. Empty when the server cannot be used. */
  async notes(request: string, notes: readonly string[], signal?: AbortSignal): Promise<Map<string, number>> {
    const texts = [...new Set(notes)];
    if (!texts.length) return new Map();
    const keyOf = (t: string): string => String(Bun.hash(forEmbedding(t)));
    const kept = new Map<string, Float32Array>();
    for (const t of texts) {
      const row = this.#db.query("SELECT v FROM notes WHERE h = ? AND model = ?").get(keyOf(t), this.#config.model) as { v: Uint8Array } | null;
      if (row) kept.set(t, fromBlob(row.v));
    }
    const missing = texts.filter((t) => !kept.has(t)).slice(0, MOST_PER_CALL);
    const made = await this.#embed([request, ...missing], signal);
    if (!made) return new Map();
    const [ask, ...vectors] = made as [Float32Array, ...Float32Array[]];
    const put = this.#db.query("INSERT OR REPLACE INTO notes (h, model, v) VALUES (?, ?, ?)");
    missing.forEach((t, i) => { kept.set(t, vectors[i]!); put.run(keyOf(t), this.#config.model, toBlob(vectors[i]!)); });
    const out = new Map<string, number>();
    for (const [t, v] of kept) if (v.length === ask.length) out.set(t, dot(ask, v));
    // A note whose vector has another size was made by another model of the same name: it is made again next time.
    for (const [t, v] of kept) if (v.length !== ask.length) this.#db.query("DELETE FROM notes WHERE h = ?").run(keyOf(t));
    return out;
  }

  /** Gives the messages of a conversation their vectors: the ones that have none (or whose text changed), up to a few at a time. Returns how many were made. */
  async index(id: string, items: readonly HistoryItem[], signal?: AbortSignal): Promise<number> {
    const messages = items.flatMap((i, at) => (i.k !== "tool" && i.text.trim() ? [{ id, n: at + 1, text: i.text }] : []));
    this.#db.query("DELETE FROM msgs WHERE session = ? AND n > ?").run(id, items.length);
    return this.#store(messages, signal);
  }

  /** Gives vectors to the newest messages that have none, a few at a time, so history from before the server was set up is caught up with search by search. */
  async catchUp(newest: readonly MessageRef[], signal?: AbortSignal): Promise<number> { return this.#store(newest.slice(0, CATCH_UP_SCAN), signal); }

  async #store(messages: readonly MessageRef[], signal?: AbortSignal): Promise<number> {
    const have = this.#db.query("SELECT h, model FROM msgs WHERE session = ? AND n = ?");
    const todo = messages.filter((m) => { const row = have.get(m.id, m.n) as { h: string; model: string } | null; return !row || row.model !== this.#config.model || row.h !== String(Bun.hash(forEmbedding(m.text))); }).slice(0, MOST_PER_CALL);
    if (!todo.length) return 0;
    const vectors = await this.#embed(todo.map((m) => m.text), signal);
    if (!vectors) return 0;
    const put = this.#db.query("INSERT OR REPLACE INTO msgs (session, n, h, model, v) VALUES (?, ?, ?, ?, ?)");
    this.#db.transaction(() => { todo.forEach((m, i) => put.run(m.id, m.n, String(Bun.hash(forEmbedding(m.text))), this.#config.model, toBlob(vectors[i]!))); })();
    this.#db.query("DELETE FROM msgs WHERE rowid IN (SELECT rowid FROM msgs ORDER BY rowid ASC LIMIT max(0, (SELECT COUNT(*) FROM msgs) - ?))").run(MOST_MESSAGE_VECTORS);
    return todo.length;
  }

  /** The messages most like the question, best first. Empty when the server cannot be used or nothing is near enough. */
  async rank(question: string, limit: number, signal?: AbortSignal): Promise<{ id: string; n: number; like: number }[]> {
    const made = await this.#embed([question], signal);
    if (!made) return [];
    const ask = made[0]!;
    const rows = this.#db.query("SELECT session AS id, n, v FROM msgs WHERE model = ?").all(this.#config.model) as { id: string; n: number; v: Uint8Array }[];
    const scored: { id: string; n: number; like: number }[] = [];
    for (const r of rows) {
      const v = fromBlob(r.v);
      if (v.length === ask.length) scored.push({ id: r.id, n: r.n, like: dot(ask, v) });
      // Another size means the model behind the same name changed: the message is made again by the next catch-up.
      else this.#db.query("DELETE FROM msgs WHERE session = ? AND n = ?").run(r.id, r.n);
    }
    scored.sort((a, b) => b.like - a.like);
    const best = scored[0]?.like ?? 0;
    return scored.filter((s) => s.like >= LEAST_LIKE && s.like >= best - WITHIN_BEST).slice(0, limit);
  }

  remove(id: string): void { this.#db.query("DELETE FROM msgs WHERE session = ?").run(id); }

  close(): void { this.#db.close(); }
}

/** How long a search waits for the server in all; past it the words alone answer. */
const SEARCH_WAIT_MS = 5_000;

/**
 * What a search finds when the words and the meaning are put together: the conversations are ordered by how well each ranks in the list
 * by words and in the list by meaning (see `fuse`). With no server, a failed one, or nothing near, it is the words alone.
 */
export async function withMeaning(db: SearchIndex, meaning: Meaning, question: string, byWords: readonly Found[], limit: number): Promise<Found[]> {
  const signal = AbortSignal.timeout(SEARCH_WAIT_MS);
  await meaning.catchUp(db.newest(CATCH_UP_SCAN), signal);
  const near = await meaning.rank(question, 50, signal);
  if (!near.length) return byWords.slice(0, limit);
  const ids = [...new Set(near.map((m) => m.id))];
  const score = fuse([byWords.map((h) => h.id), ids]);
  const found = new Map<string, Found>(byWords.map((h) => [h.id, h]));
  for (const m of near) if (!found.has(m.id)) { const p = db.passage(m.id, m.n); if (p) found.set(m.id, p); }
  return [...found.values()].sort((a, b) => (score.get(b.id) ?? 0) - (score.get(a.id) ?? 0)).slice(0, limit);
}

/** What the standing notes need from meaning search: asked once for each thing the person writes (not at every step), given up after 3 seconds. */
export function notesByMeaning(meaning: Meaning, texts: () => string[]): { prepare(request: { userText: string }): Promise<void>; like(): ReadonlyMap<string, number> | undefined; notice(): string | undefined } {
  let like: ReadonlyMap<string, number> | undefined;
  let asked = "";
  return {
    async prepare({ userText }) {
      const all = texts(), what = [userText, ...all].join("\u0000");
      if (what === asked) return;
      asked = what;
      like = await meaning.notes(userText, all, AbortSignal.timeout(3_000));
    },
    like: () => like,
    notice: () => meaning.notice(),
  };
}

const open = new Map<string, Meaning>();
/** The meaning search of a computer, when the person set up a server for it, and nothing when not: the same object for the same server and file. */
export function meaningFor(settings: EmbeddingSettings | undefined, env: Record<string, string | undefined>, path: string): Meaning | undefined {
  const config = embeddingConfig(settings, env);
  if (!config) return undefined;
  const key = `${path}|${config.api}|${config.baseUrl}|${config.model}`;
  try { let m = open.get(key); if (!m) { m = new Meaning(config, path); open.set(key, m); } return m; } catch { return undefined; }
}
