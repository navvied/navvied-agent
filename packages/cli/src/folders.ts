import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

/** A folder this computer offers to work in. `id` stands for the path: a page names a folder by it and never types a path. */
export interface Folder { id: string; name: string; /** Shown on the same machine only. */ path: string; last?: number; current?: boolean }

const MOST_RECENT = 20;
/** The real place of a folder: links followed, so the same folder has one id however it was named (on a Mac `/tmp` is a link). */
export const real = (path: string): string => { const full = resolve(path); try { return realpathSync(full); } catch { return full; } };
export const folderId = (path: string): string => createHash("sha256").update(real(path)).digest("hex").slice(0, 12);
const isDir = (p: string): boolean => { try { return statSync(p).isDirectory(); } catch { return false; } };

/**
 * The folders an agent may be started in: the one the program was started in, the ones worked in lately, and the ones the person named
 * in their own configuration (`"folders"`). Adding one happens on the computer, never from a page.
 */
export class FolderBook {
  constructor(private readonly file: string) {}

  #recent(): { path: string; last: number }[] {
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as { recent?: unknown };
      return Array.isArray(raw.recent) ? raw.recent.filter((r): r is { path: string; last: number } => typeof r === "object" && r !== null && typeof (r as { path?: unknown }).path === "string" && typeof (r as { last?: unknown }).last === "number") : [];
    } catch { return []; }
  }

  /** Remember that work took place in this folder. */
  used(path: string, now = Date.now()): void {
    const full = real(path);
    const list = [{ path: full, last: now }, ...this.#recent().filter((r) => r.path !== full)].slice(0, MOST_RECENT);
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: 1, recent: list }));
      renameSync(tmp, this.file);
    } catch { /* a full disk must not stop the work */ }
  }

  /** What is offered, the current one first, then the latest used, then the named ones. Folders that are gone are left out. */
  offered(current: string | undefined, named: readonly string[] = []): Folder[] {
    const out = new Map<string, Folder>();
    const add = (path: string, last?: number): void => {
      const full = real(path);
      if (out.has(full) || !isDir(full)) return;
      out.set(full, { id: folderId(full), name: basename(full) || full, path: full, ...(last ? { last } : {}), ...(current && real(current) === full ? { current: true } : {}) });
    };
    if (current) add(current, Date.now());
    for (const r of this.#recent()) add(r.path, r.last);
    for (const n of named) add(n);
    return [...out.values()];
  }

  /** The path behind an id the hub itself offered. Nothing else is ever resolved. */
  resolve(id: string, current: string | undefined, named: readonly string[] = []): string | undefined {
    return this.offered(current, named).find((f) => f.id === id)?.path;
  }
}
