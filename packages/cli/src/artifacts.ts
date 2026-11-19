import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";

/** A file a conversation wrote, as a list shows it. `path` is for showing on the same machine; a file is named by `id` and by nothing else. */
export interface ArtifactInfo { id: string; conversation: string; name: string; bytes: number; updated: number; mime: string; path?: string }

const MOST = 500;
const MAX_READ = 1_000_000;
const TEXT: Record<string, string> = { ".txt": "text/plain", ".md": "text/markdown", ".json": "application/json", ".csv": "text/csv", ".html": "text/html", ".htm": "text/html", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript", ".ts": "text/typescript", ".tsx": "text/typescript", ".jsx": "text/javascript", ".py": "text/x-python", ".sh": "text/x-shellscript", ".yml": "text/yaml", ".yaml": "text/yaml", ".toml": "text/plain", ".xml": "application/xml", ".svg": "image/svg+xml", ".sql": "text/plain", ".log": "text/plain", ".rs": "text/plain", ".go": "text/plain", ".java": "text/plain", ".c": "text/plain", ".h": "text/plain", ".cpp": "text/plain" };
const IMAGE: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };

/** What a file is, by its name. Unknown kinds are `application/octet-stream`: listed, never previewed. */
export const mimeOf = (path: string): string => { const e = extname(path).toLowerCase(); return TEXT[e] ?? IMAGE[e] ?? "application/octet-stream"; };
export const artifactId = (conversation: string, path: string): string => createHash("sha256").update(`${conversation}\n${resolve(path)}`).digest("hex").slice(0, 16);

interface Entry { id: string; conversation: string; path: string; updated: number }

/** The files conversations wrote, kept next to the conversations (only where they are: nothing goes to a server). */
export class ArtifactBook {
  constructor(private readonly file: string) {}

  #read(): Entry[] {
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as { items?: unknown };
      return Array.isArray(raw.items) ? raw.items.filter((r): r is Entry => typeof r === "object" && r !== null && typeof (r as Entry).id === "string" && typeof (r as Entry).path === "string" && typeof (r as Entry).conversation === "string") : [];
    } catch { return []; }
  }

  #write(items: Entry[]): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: 1, items: items.slice(-MOST) }));
      renameSync(tmp, this.file);
    } catch { /* a full disk must not stop the work */ }
  }

  /** Takes away what is remembered of a conversation (the files it wrote are the person's own and stay). */
  forget(conversation: string): void {
    const rest = this.#read().filter((r) => r.conversation !== conversation);
    if (rest.length !== this.#read().length) this.#write(rest);
  }

  /** Remember that this conversation wrote this file. */
  add(conversation: string, path: string, now = Date.now()): void {
    const full = resolve(path);
    const id = artifactId(conversation, full);
    this.#write([...this.#read().filter((r) => r.id !== id), { id, conversation, path: full, updated: now }]);
  }

  /** The files, newest first (of one conversation, when asked); those that are gone are left out. */
  list(conversation?: string): ArtifactInfo[] {
    const out: ArtifactInfo[] = [];
    for (const r of this.#read()) {
      if (conversation && r.conversation !== conversation) continue;
      try {
        const st = statSync(r.path);
        if (!st.isFile()) continue;
        out.push({ id: r.id, conversation: r.conversation, name: basename(r.path), bytes: st.size, updated: Math.max(Math.round(st.mtimeMs), r.updated), mime: mimeOf(r.path), path: r.path });
      } catch { /* gone */ }
    }
    return out.sort((a, b) => b.updated - a.updated);
  }

  /** The content of a file the book knows, to show: text (cut at 1 MB) or an image (as base64); anything else is not previewed. */
  read(id: string): { info: ArtifactInfo; text?: string; data?: string; truncated?: true } | { error: string } {
    const info = this.list().find((a) => a.id === id);
    if (!info) return { error: "That file is gone." };
    if (TEXT[extname(info.name).toLowerCase()]) {
      const raw = readFileSync(info.path!);
      const cut = raw.length > MAX_READ;
      return { info, text: raw.subarray(0, MAX_READ).toString("utf8"), ...(cut ? { truncated: true as const } : {}) };
    }
    if (IMAGE[extname(info.name).toLowerCase()]) {
      if (info.bytes > MAX_READ) return { error: "That picture is too large to show here." };
      return { info, data: readFileSync(info.path!).toString("base64") };
    }
    return { error: "This kind of file cannot be shown here." };
  }
}

/** The files under a folder with their size and time, a few levels deep, to see later which are new or changed. */
export function scanFolder(dir: string, depth = 4, limit = 2000): Map<string, string> {
  const seen = new Map<string, string>();
  const walk = (d: string, level: number): void => {
    if (seen.size >= limit) return;
    let names: string[];
    try { names = readdirSync(d); } catch { return; }
    for (const name of names) {
      const p = join(d, name);
      try {
        const st = statSync(p);
        if (st.isFile()) seen.set(p, `${st.size}:${Math.round(st.mtimeMs)}`);
        else if (st.isDirectory() && level < depth && !name.startsWith(".")) walk(p, level + 1);
      } catch { /* gone */ }
      if (seen.size >= limit) return;
    }
  };
  walk(dir, 0);
  return seen;
}
