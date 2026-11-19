import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const MOST = 100;
export interface Draft { key: string; text: string; updated: number }

/**
 * What the person typed and did not send, for each conversation and for a new one, kept on this computer so that a refresh, another
 * window or another device finds it where they left it. It never leaves the computer: for a conversation of this computer that is the point.
 */
export class DraftStore {
  #drafts: Draft[] | undefined;
  constructor(private readonly file: string, private readonly now: () => number = Date.now) {}

  list(): Draft[] {
    if (this.#drafts) return this.#drafts;
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as { drafts?: unknown };
      this.#drafts = Array.isArray(raw.drafts) ? raw.drafts.filter((d): d is Draft => typeof d === "object" && d !== null && typeof (d as Draft).key === "string" && typeof (d as Draft).text === "string" && typeof (d as Draft).updated === "number") : [];
    } catch { this.#drafts = []; }
    return this.#drafts;
  }

  /** Keeps the text for `key`; empty text takes the draft away. */
  set(key: string, text: string): void {
    const kept = this.list().filter((d) => d.key !== key);
    if (text.length) kept.push({ key, text, updated: this.now() });
    this.#drafts = kept.sort((a, b) => b.updated - a.updated).slice(0, MOST);
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: 1, drafts: this.#drafts }), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch { /* a draft is a convenience: a full disk must not stop the work */ }
  }
}
