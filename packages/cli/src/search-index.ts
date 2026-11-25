import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { HistoryItem, SearchHit } from "@navvied/protocol";

/** The words of a search as a query the index understands: every word must be there, the last one may be only a start. Nothing a person types can break it. */
export function matchQuery(text: string, any = false): string | undefined {
  const words = text.toLowerCase().match(/[\p{L}\p{N}_]+/gu)?.slice(0, 12);
  if (!words?.length) return undefined;
  return words.map((w, i) => (i === words.length - 1 ? `"${w}"*` : `"${w}"`)).join(any ? " OR " : " AND ");
}

/** What tells one message from another one in the same place: if the last indexed message still has this, nothing before it changed. */
const stamp = (i: HistoryItem): string => `${i.k}:${i.text.length}:${Bun.hash(i.text)}`;

/** A search result: the conversation, and which of its items matched (1-based). */
export type Found = SearchHit & { n: number };

/** Bump when the table changes: an older index is dropped and rebuilt from the conversations. */
const VERSION = 3;

/**
 * A search over what was said in the saved conversations: SQLite's full-text index, so it finds words in any language at once,
 * ranks the best matches first, and asks no model. It is rebuilt from the conversations if the file is lost.
 */
export class SearchIndex {
  readonly #db: Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.#db = new Database(path, { create: true });
    this.#db.exec("PRAGMA journal_mode = WAL;");
    if ((this.#db.query("PRAGMA user_version").get() as { user_version: number }).user_version < VERSION) {
      this.#db.exec("DROP TABLE IF EXISTS sessions; DROP TABLE IF EXISTS turns;");
      this.#db.exec(`PRAGMA user_version = ${VERSION}`);
    }
    this.#db.exec("CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, updated INTEGER NOT NULL, count INTEGER NOT NULL DEFAULT 0, tail TEXT NOT NULL DEFAULT '')");
    this.#db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS turns USING fts5(session UNINDEXED, n UNINDEXED, text, tokenize = 'unicode61 remove_diacritics 2')");
  }

  /** Whether anything has been indexed yet, so a first search knows to read the old conversations in. */
  get empty(): boolean { return (this.#db.query("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n === 0; }

  /**
   * Brings one conversation up to date and returns how many messages were written. A conversation only grows between two turns, so
   * when the last message already indexed is still the same, only the messages after it are added; anything else (an edit, a branch,
   * a shorter history) writes the conversation again. Tool names are not text and are left out.
   */
  put(id: string, title: string, updated: number, items: readonly HistoryItem[]): number {
    const write = this.#db.transaction((): number => {
      const had = this.#db.query("SELECT count, tail FROM sessions WHERE id = ?").get(id) as { count: number; tail: string } | null;
      const same = !!had && had.count > 0 && had.count <= items.length && stamp(items[had.count - 1]!) === had.tail;
      if (!same) this.#db.query("DELETE FROM turns WHERE session = ?").run(id);
      const from = same ? had!.count : 0;
      this.#db.query("INSERT INTO sessions (id, title, updated, count, tail) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title = excluded.title, updated = excluded.updated, count = excluded.count, tail = excluded.tail").run(id, title, updated, items.length, items.length ? stamp(items.at(-1)!) : "");
      const add = this.#db.query("INSERT INTO turns (session, n, text) VALUES (?, ?, ?)");
      let written = 0;
      for (let at = from; at < items.length; at++) { const i = items[at]!; if (i.k !== "tool" && i.text.trim()) { add.run(id, at + 1, i.text); written++; } }
      return written;
    });
    return write();
  }

  remove(id: string): void {
    this.#db.query("DELETE FROM turns WHERE session = ?").run(id);
    this.#db.query("DELETE FROM sessions WHERE id = ?").run(id);
  }

  /** The conversations that mention every word (any of them, with `loose`), best first, one passage each. */
  search(text: string, limit = 10, loose = false, now = Date.now()): Found[] {
    const query = matchQuery(text, loose);
    if (!query) return [];
    const rows = this.#db.query(
      `SELECT t.session AS id, s.title AS title, s.updated AS updated, t.n AS n, snippet(turns, 2, '[', ']', '…', 14) AS snippet, bm25(turns) AS rank
       FROM turns t JOIN sessions s ON s.id = t.session WHERE turns MATCH ? ORDER BY rank LIMIT ?`,
    ).all(query, limit * 4) as { id: string; title: string; updated: number; n: number; snippet: string; rank: number }[];
    // bm25 is lower for a better match; a conversation of the last weeks counts up to half as much again, so of two equal matches the fresher comes first.
    const weight = (r: { rank: number; updated: number }): number => r.rank * (1 + 0.5 / (1 + Math.max(0, now - r.updated) / (30 * 86_400_000)));
    rows.sort((a, b) => weight(a) - weight(b));
    const seen = new Set<string>();
    const hits: Found[] = [];
    for (const r of rows) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      hits.push({ id: r.id, title: r.title, snippet: r.snippet.replace(/\s+/g, " "), updated: r.updated, n: r.n });
      if (hits.length >= limit) break;
    }
    return hits;
  }

  /** The conversations most recently worked on. */
  recent(limit = 10): { id: string; title: string; updated: number }[] {
    return this.#db.query("SELECT id, title, updated FROM sessions ORDER BY updated DESC LIMIT ?").all(limit) as { id: string; title: string; updated: number }[];
  }

  close(): void { this.#db.close(); }
}
