import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * What a person did to their list of conversations, kept next to the conversations: the titles they gave, the ones they pinned and the
 * ones they deleted (so a copy that is still on the account is not shown again). One file per kind of conversation.
 */
export interface SessionMeta { titles: Record<string, string>; pinned: string[]; removed: string[]; archived: string[]; unread: string[]; done: string[] }

const MOST_REMOVED = 500;

export class SessionMetaFile {
  constructor(private readonly path: string) {}

  read(): SessionMeta {
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as Partial<SessionMeta>;
      const titles = typeof raw.titles === "object" && raw.titles !== null && !Array.isArray(raw.titles) ? Object.fromEntries(Object.entries(raw.titles).filter(([, v]) => typeof v === "string")) as Record<string, string> : {};
      const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
      return { titles, pinned: list(raw.pinned), removed: list(raw.removed), archived: list(raw.archived), unread: list(raw.unread), done: list(raw.done) };
    } catch { return { titles: {}, pinned: [], removed: [], archived: [], unread: [], done: [] }; }
  }

  update(change: (meta: SessionMeta) => void): SessionMeta {
    const meta = this.read();
    change(meta);
    meta.removed = meta.removed.slice(-MOST_REMOVED);
    meta.unread = meta.unread.slice(-MOST_REMOVED);
    meta.done = meta.done.slice(-MOST_REMOVED);
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: 1, ...meta }));
      renameSync(tmp, this.path);
    } catch { /* a full disk must not stop the conversation */ }
    return meta;
  }
}
