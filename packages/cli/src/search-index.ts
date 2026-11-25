import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { closest, fold, hideInItems, hideSecrets, isDense, wordsOf } from "@navvied/engine";
import type { HistoryItem, SearchHit } from "@navvied/protocol";

/** The words of a search as a query the index understands: every word must be there, the last one may be only a start. Nothing a person types can break it. */
export function matchQuery(text: string, any = false): string | undefined {
  const words = text.toLowerCase().match(/[\p{L}\p{N}_]+/gu)?.slice(0, 12);
  if (!words?.length) return undefined;
  return words.map((w, i) => (i === words.length - 1 ? `"${w}"*` : `"${w}"`)).join(any ? " OR " : " AND ");
}

/** What tells one message from another one in the same place: if the last indexed message still has this, nothing before it changed. */
const stamp = (i: HistoryItem): string => `${i.k}:${i.text.length}:${Bun.hash(i.text)}`;

interface Row { id: string; title: string; updated: number; n: number; snippet: string; rank: number }

/** A search result: the conversation, and which of its items matched (1-based). */
export type Found = SearchHit & { n: number };

/** Bump when the table changes: an older index is dropped and rebuilt from the conversations. */
const VERSION = 4;
/** How many words of the index a word that nothing has is compared with, to find the one it was meant to be. */
const VOCABULARY_READ = 5_000;

/**
 * A search over what was said in the saved conversations: SQLite's full-text index, so it finds words in any language at once,
 * ranks the best matches first, and asks no model. It is rebuilt from the conversations if the file is lost. When the words do not
 * find it, it looks for the letters themselves (a word inside another, Chinese and Japanese, which have no spaces) and then for the
 * words one slip away (a typo). It does not know that two words mean the same: that is `meaning.ts`, when a server for it is set up.
 */
export class SearchIndex {
  readonly #db: Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.#db = new Database(path, { create: true });
    this.#db.exec("PRAGMA journal_mode = WAL;");
    if ((this.#db.query("PRAGMA user_version").get() as { user_version: number }).user_version < VERSION) {
      this.#db.exec("DROP TABLE IF EXISTS sessions; DROP TABLE IF EXISTS turns_vocab; DROP TABLE IF EXISTS turns; DROP TABLE IF EXISTS grams;");
      this.#db.exec(`PRAGMA user_version = ${VERSION}`);
    }
    this.#db.exec("CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, updated INTEGER NOT NULL, count INTEGER NOT NULL DEFAULT 0, tail TEXT NOT NULL DEFAULT '')");
    this.#db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS turns USING fts5(session UNINDEXED, n UNINDEXED, text, tokenize = 'unicode61 remove_diacritics 2')");
    this.#db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS grams USING fts5(session UNINDEXED, n UNINDEXED, text, tokenize = 'trigram')");
    this.#db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS turns_vocab USING fts5vocab(turns, 'row')");
  }

  /** Whether anything has been indexed yet, so a first search knows to read the old conversations in. */
  get empty(): boolean { return (this.#db.query("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n === 0; }

  /**
   * Brings one conversation up to date and returns how many messages were written. A conversation only grows between two turns, so
   * when the last message already indexed is still the same, only the messages after it are added; anything else (an edit, a branch,
   * a shorter history) writes the conversation again. Tool names are not text and are left out.
   */
  put(id: string, title: string, updated: number, typed: readonly HistoryItem[]): number {
    // What the person typed as a secret is never in the index, whoever asks for it to be put there.
    const items = hideInItems(typed);
    const write = this.#db.transaction((): number => {
      const had = this.#db.query("SELECT count, tail FROM sessions WHERE id = ?").get(id) as { count: number; tail: string } | null;
      const same = !!had && had.count > 0 && had.count <= items.length && stamp(items[had.count - 1]!) === had.tail;
      if (!same) this.#clear(id);
      const from = same ? had!.count : 0;
      this.#db.query("INSERT INTO sessions (id, title, updated, count, tail) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title = excluded.title, updated = excluded.updated, count = excluded.count, tail = excluded.tail").run(id, hideSecrets(title), updated, items.length, items.length ? stamp(items.at(-1)!) : "");
      const add = this.#db.query("INSERT INTO turns (session, n, text) VALUES (?, ?, ?)");
      const addLetters = this.#db.query("INSERT INTO grams (session, n, text) VALUES (?, ?, ?)");
      let written = 0;
      for (let at = from; at < items.length; at++) { const i = items[at]!; if (i.k !== "tool" && i.text.trim()) { add.run(id, at + 1, i.text); addLetters.run(id, at + 1, fold(i.text)); written++; } }
      return written;
    });
    return write();
  }

  #clear(id: string): void {
    this.#db.query("DELETE FROM turns WHERE session = ?").run(id);
    this.#db.query("DELETE FROM grams WHERE session = ?").run(id);
  }

  remove(id: string): void {
    this.#clear(id);
    this.#db.query("DELETE FROM sessions WHERE id = ?").run(id);
  }

  /** The newest messages, the newest conversation first and its last message first: what a search by meaning gives vectors to. */
  newest(limit: number): { id: string; n: number; text: string }[] {
    return this.#db.query("SELECT t.session AS id, t.n AS n, t.text AS text FROM turns t JOIN sessions s ON s.id = t.session ORDER BY s.updated DESC, t.n DESC LIMIT ?").all(limit) as { id: string; n: number; text: string }[];
  }

  /** One message as a search result, for a message that was found by meaning and not by its words. */
  passage(id: string, n: number): Found | undefined {
    const s = this.#db.query("SELECT title, updated FROM sessions WHERE id = ?").get(id) as { title: string; updated: number } | null;
    const said = this.text(id, n);
    return s && said !== undefined ? { id, title: s.title, snippet: said.replace(/\s+/g, " ").slice(0, 160), updated: s.updated, n } : undefined;
  }

  /** The text of one message as it was said, or nothing. */
  text(id: string, n: number): string | undefined {
    return (this.#db.query("SELECT text FROM turns WHERE session = ? AND n = ?").get(id, n) as { text: string } | null)?.text;
  }

  /**
   * The conversations that mention every word (any of them, with `loose`), best first, one passage each. When no word matches: the
   * conversations that hold the letters (not with `loose`), then the ones that hold the words as corrected for a slip.
   */
  search(text: string, limit = 10, loose = false, now = Date.now()): Found[] {
    const stages: (() => Row[])[] = isDense(text)
      ? [() => this.#inside(text, limit)]
      : loose
        ? [() => this.#words(text, limit, true), () => this.#corrected(text, limit, true)]
        : [() => this.#words(text, limit, false), () => this.#inside(text, limit), () => this.#corrected(text, limit, false)];
    for (const stage of stages) {
      const rows = stage();
      if (rows.length) return this.#best(rows, limit, now);
    }
    return [];
  }

  #words(text: string, limit: number, loose: boolean): Row[] {
    const query = matchQuery(text, loose);
    if (!query) return [];
    return this.#db.query(
      `SELECT t.session AS id, s.title AS title, s.updated AS updated, t.n AS n, snippet(turns, 2, '[', ']', '…', 14) AS snippet, bm25(turns) AS rank
       FROM turns t JOIN sessions s ON s.id = t.session WHERE turns MATCH ? ORDER BY rank LIMIT ?`,
    ).all(query, limit * 4) as Row[];
  }

  /** Messages that hold every word as letters, anywhere in a word or in a text without spaces. A word of one or two letters cannot be looked up in a trigram index and is scanned for. */
  #inside(text: string, limit: number): Row[] {
    const tokens = wordsOf(text).slice(0, 12);
    if (!tokens.length) return [];
    const long = tokens.filter((t) => [...t].length >= 3), short = tokens.filter((t) => [...t].length < 3);
    const where = [...(long.length ? ["grams MATCH ?"] : []), ...short.map(() => "text LIKE ?")];
    const args = [...(long.length ? [long.map((t) => `"${t}"`).join(" AND ")] : []), ...short.map((t) => `%${t}%`)];
    const rows = this.#db.query(
      `SELECT g.session AS id, s.title AS title, s.updated AS updated, g.n AS n, '' AS snippet, ${long.length ? "bm25(grams)" : "0"} AS rank
       FROM grams g JOIN sessions s ON s.id = g.session WHERE ${where.join(" AND ")} LIMIT ?`,
    ).all(...args, limit * 4) as Row[];
    return rows.map((r) => ({ ...r, snippet: this.#around(r.id, r.n, tokens[0]!) }));
  }

  /** The words of the request that no message has, replaced by the closest word one or two slips away, searched as ordinary words. */
  #corrected(text: string, limit: number, loose: boolean): Row[] {
    let changed = false;
    const fixed = wordsOf(text).slice(0, 12).map((w) => {
      if (this.#has(w)) return w;
      const near = this.#db.query("SELECT term FROM turns_vocab WHERE length(term) BETWEEN ? AND ? ORDER BY cnt DESC LIMIT ?").all(w.length - 2, w.length + 2, VOCABULARY_READ) as { term: string }[];
      const fix = closest(w, near.map((r) => r.term));
      if (fix) changed = true;
      return fix ?? w;
    });
    return changed ? this.#words(fixed.join(" "), limit, loose) : [];
  }

  /** Whether some message has this word, or a word that starts with it. */
  #has(word: string): boolean {
    return this.#db.query("SELECT 1 FROM turns_vocab WHERE term >= ? AND term < ? LIMIT 1").get(word, `${word}￿`) !== null;
  }

  /** A passage of a message around the first place `token` is in it, with the match in brackets, taken from the message as it was said. */
  #around(id: string, n: number, token: string): string {
    const said = this.text(id, n) ?? "";
    const at = Math.max(0, fold(said).indexOf(token));
    const from = Math.max(0, at - 40), to = Math.min(said.length, at + token.length + 80);
    return `${from ? "…" : ""}${said.slice(from, at)}[${said.slice(at, at + token.length)}]${said.slice(at + token.length, to)}${to < said.length ? "…" : ""}`;
  }

  /** One passage for each conversation, the best first: bm25 is lower for a better match, and a conversation of the last weeks counts up to half as much again, so of two equal matches the fresher comes first. */
  #best(rows: Row[], limit: number, now: number): Found[] {
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
