import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Message, SessionStore, SessionSummary } from "./types.ts";

const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;

/** One JSON file per session, written atomically. */
export class FileSessionStore implements SessionStore {
  constructor(private readonly dir: string) {}

  private file(id: string): string {
    if (!SAFE_ID.test(id)) throw new Error("invalid session id");
    return join(this.dir, `${id}.json`);
  }

  save(id: string, messages: Message[]): void {
    mkdirSync(this.dir, { recursive: true });
    const target = this.file(id), tmp = `${target}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, messages }));
    renameSync(tmp, target);
  }

  load(id: string): Message[] | null {
    try {
      const data = JSON.parse(readFileSync(this.file(id), "utf8")) as { messages?: Message[] };
      return Array.isArray(data.messages) ? data.messages : null;
    } catch { return null; }
  }

  /** The newest sessions (at most `limit`), each with a title made from what the person asked first. Files that cannot be read are left out. */
  list(limit = 50): SessionSummary[] {
    let names: string[];
    try { names = readdirSync(this.dir); } catch { return []; }
    const found: { id: string; updated: number }[] = [];
    for (const name of names) {
      const id = /^([A-Za-z0-9_-]{1,80})\.json$/.exec(name)?.[1];
      if (!id) continue;
      try { found.push({ id, updated: statSync(join(this.dir, name)).mtimeMs }); } catch { /* gone meanwhile */ }
    }
    found.sort((a, b) => b.updated - a.updated);
    const out: SessionSummary[] = [];
    for (const { id, updated } of found) {
      if (out.length >= limit) break;
      const messages = this.load(id);
      if (!messages?.length) continue;
      out.push({ id, updated: Math.round(updated), messages: messages.length, title: titleOf(messages) });
    }
    return out;
  }
}

const textOf = (m: Message): string => (typeof m.content === "string" ? m.content : (m.content ?? []).map((p) => (p.type === "text" ? p.text : "")).join(" "));

/** What a session is called in a list: the first thing the person asked, on one line. */
export function titleOf(messages: Message[]): string {
  const first = messages.find((m) => m.role === "user" && textOf(m).trim());
  const line = first ? textOf(first).replace(/\s+/g, " ").trim() : "";
  return line.length > 60 ? `${line.slice(0, 59)}…` : line || "Conversation";
}

/** A saved conversation in short form, for a window that opens it: what was asked, what was answered, which tools were used. */
export function historyOf(messages: Message[], most = 200): { k: "user" | "assistant" | "tool"; text: string }[] {
  const items: { k: "user" | "assistant" | "tool"; text: string }[] = [];
  const cut = (s: string): string => (s.length > 4000 ? `${s.slice(0, 3999)}…` : s);
  for (const m of messages) {
    if (m.role === "user") { const t = textOf(m).trim(); if (t) items.push({ k: "user", text: cut(t) }); }
    else if (m.role === "assistant") {
      const t = textOf(m).trim();
      if (t) items.push({ k: "assistant", text: cut(t) });
      for (const c of m.toolCalls ?? []) items.push({ k: "tool", text: c.name });
    }
  }
  return items.slice(-most);
}

/** For tests and one-off runs. */
export class MemorySessionStore implements SessionStore {
  #sessions = new Map<string, Message[]>();
  save(id: string, messages: Message[]): void { this.#sessions.set(id, structuredClone(messages)); }
  load(id: string): Message[] | null { const m = this.#sessions.get(id); return m ? structuredClone(m) : null; }
}
