import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hideInItems, hideSecrets, type Message } from "@navvied/engine";
import type { EngineEvent, HistoryItem, SessionInfo } from "@navvied/protocol";

const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;
const MOST_ITEMS = 400;
const CUT = 4000;

export const titleOf = (items: readonly HistoryItem[]): string => {
  const first = items.find((i) => i.k === "user");
  const line = first ? hideSecrets(first.text).replace(/\s+/g, " ").trim() : "";
  return line.length > 60 ? `${line.slice(0, 59)}…` : line || "Conversation";
};

/**
 * A record of what was said in each conversation, kept apart from the engine. A model reached through a program (which keeps its
 * own sessions and cannot list them for us) still has its conversations listed and shown to every window, because this watches
 * the events instead of asking the engine. One JSON file per conversation, written atomically.
 */
export class Journal {
  #id: string | undefined;
  #items: HistoryItem[] = [];
  #said = "";
  #tools = new Set<string>();
  #dirty = false;

  constructor(private readonly dir: string, private readonly saved?: (id: string, items: readonly HistoryItem[]) => void, private readonly project?: () => string | undefined) {}

  /** Follows one event of the engine. */
  record(e: EngineEvent): void {
    if (e.ev === "session" || e.ev === "loaded") { this.#flush(); this.#switch(e.id, e.ev === "loaded" ? e.items : undefined); return; }
    if (!this.#id) return;
    if (e.ev === "user") { this.#settle(); this.#push({ k: "user", text: e.text, ...(SAFE_ID.test(e.qid) ? { qid: e.qid } : {}), ...(e.from ? { from: e.from } : {}) }); this.#save(); }
    else if (e.ev === "text") this.#said += e.text;
    else if (e.ev === "tool" && e.status === "running" && !this.#tools.has(e.id)) { this.#tools.add(e.id); this.#settle(); this.#push({ k: "tool", text: e.name }); }
    else if (e.ev === "done") { this.#settle(); this.#save(); this.#tools.clear(); }
  }

  /** The conversations kept, newest first. */
  list(limit = 50): SessionInfo[] {
    let names: string[];
    try { names = readdirSync(this.dir); } catch { return []; }
    const found: SessionInfo[] = [];
    for (const name of names) {
      const id = /^([A-Za-z0-9_-]{1,80})\.json$/.exec(name)?.[1];
      if (!id) continue;
      try {
        const file = join(this.dir, name);
        const data = JSON.parse(readFileSync(file, "utf8")) as { items?: HistoryItem[]; project?: unknown };
        if (!Array.isArray(data.items) || !data.items.length) continue;
        found.push({ id, title: titleOf(data.items), updated: Math.round(statSync(file).mtimeMs), messages: data.items.length, ...(typeof data.project === "string" && data.project ? { project: data.project } : {}) });
      } catch { /* unreadable: left out */ }
    }
    return found.sort((a, b) => b.updated - a.updated).slice(0, limit);
  }

  /** A copy of a conversation under another id (a fork), with its project, without the secrets the person typed. False when there is nothing to copy. */
  copy(id: string, newId: string): boolean {
    if (!SAFE_ID.test(id) || !SAFE_ID.test(newId)) return false;
    try {
      const data = JSON.parse(readFileSync(join(this.dir, `${id}.json`), "utf8")) as { items?: HistoryItem[]; project?: unknown };
      if (!Array.isArray(data.items)) return false;
      this.#write(newId, hideInItems(data.items), typeof data.project === "string" ? data.project : undefined);
      return true;
    } catch { return false; }
  }

  /** Writes down a conversation that was not watched (a copy made from the engine's own saved messages). */
  write(id: string, items: readonly HistoryItem[], project?: string): void {
    if (!SAFE_ID.test(id) || !items.length) return;
    try { this.#write(id, items.slice(-MOST_ITEMS), project); } catch { /* a full disk must not stop the conversation */ }
  }

  /** The one way a conversation reaches its file: only its owner reads it, because it holds what they typed. */
  #write(id: string, items: readonly HistoryItem[], project?: string): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const target = join(this.dir, `${id}.json`), tmp = `${target}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, ...(project ? { project } : {}), items }), { mode: 0o600 });
    renameSync(tmp, target);
  }

  /** Forgets a conversation. If it is the one being followed, what was heard of it so far is let go too. */
  remove(id: string): void {
    if (!SAFE_ID.test(id)) return;
    if (this.#id === id) { this.#id = undefined; this.#items = []; this.#said = ""; this.#tools.clear(); this.#dirty = false; }
    try { rmSync(join(this.dir, `${id}.json`), { force: true }); } catch { /* it was not there */ }
  }

  items(id: string): HistoryItem[] | undefined {
    if (!SAFE_ID.test(id)) return undefined;
    try {
      const data = JSON.parse(readFileSync(join(this.dir, `${id}.json`), "utf8")) as { items?: HistoryItem[] };
      return Array.isArray(data.items) ? data.items : undefined;
    } catch { return undefined; }
  }

  #switch(id: string, items: HistoryItem[] | undefined): void {
    if (!SAFE_ID.test(id)) { this.#id = undefined; return; }
    this.#id = id;
    this.#items = items ? items.slice(-MOST_ITEMS) : this.items(id) ?? [];
    this.#said = "";
    this.#tools.clear();
    this.#dirty = false;
  }

  #push(item: HistoryItem): void {
    this.#items.push({ k: item.k, text: item.text.length > CUT ? `${item.text.slice(0, CUT - 1)}…` : item.text, ...(item.qid ? { qid: item.qid } : {}) });
    if (this.#items.length > MOST_ITEMS) this.#items.splice(0, this.#items.length - MOST_ITEMS);
    this.#dirty = true;
  }

  #settle(): void {
    const text = this.#said.trim();
    this.#said = "";
    if (text) this.#push({ k: "assistant", text });
  }

  #flush(): void { this.#settle(); this.#save(); }

  #save(): void {
    if (!this.#id || !this.#dirty) return;
    try {
      this.#write(this.#id, this.#items, this.project?.());
      this.#dirty = false;
      this.saved?.(this.#id, this.#items);
    } catch { /* a full disk must not stop the conversation */ }
  }
}

/** A conversation as the engine's own store keeps it, made from what was watched: what was asked and answered. The tools used are not kept, only what was said. */
/** The ids the journal kept for what the person said, put on the same messages of a conversation that came from somewhere that does not keep them (the engine's own record), matched in order by their words. */
export function withQids(items: readonly HistoryItem[], kept: readonly HistoryItem[] | undefined): HistoryItem[] {
  const ids = (kept ?? []).filter((i) => i.k === "user" && i.qid);
  let at = 0;
  return items.map((i) => {
    if (i.k !== "user" || i.qid) return i;
    const found = ids.findIndex((k, n) => n >= at && k.text === i.text);
    if (found < 0) return i;
    at = found + 1;
    return { ...i, qid: ids[found]!.qid! };
  });
}

export const messagesOf = (items: readonly HistoryItem[]): Message[] =>
  items.flatMap((i): Message[] => (i.k === "user" ? [{ role: "user", content: i.text }] : i.k === "assistant" ? [{ role: "assistant", content: i.text }] : []));
