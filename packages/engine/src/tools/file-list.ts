import { readdirSync } from "node:fs";
import { join } from "node:path";
import { run } from "./util.ts";

/** Most files looked at in one search: past this a search is said to have stopped early, never silently cut. */
export const MOST_SCANNED = 100_000;
const SKIP_DIRS = new Set(["node_modules", ".git"]);

export interface Listing { files: string[]; /** The list stopped at the limit. */ partial: boolean; /** Which way it was made: files ignored by `.gitignore` are left out by the first two only. */ by: "rg" | "git" | "walk" }

const has = (program: string): boolean => Bun.which(program, { PATH: process.env.PATH ?? "" }) !== null;

/** Every file below `root` (paths relative to it, `/` separated): ripgrep's list when there is ripgrep, else git's, else a plain walk. The first two follow `.gitignore`. */
export async function listFiles(root: string, o: { hidden: boolean; signal: AbortSignal }): Promise<Listing> {
  const base = { cwd: root, signal: o.signal, timeoutMs: 60_000, maxOutput: 50_000_000 };
  if (has("rg")) {
    const r = await run(["rg", "--files", "--no-messages", ...(o.hidden ? ["--hidden"] : []), "-g", "!.git", "-g", "!node_modules"], base);
    if (r.code === 0 || r.code === 1) return cut(r.output.split("\n"), "rg");
  }
  if (has("git")) {
    const r = await run(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], base);
    if (r.code === 0) return cut(r.output.split("\0").filter((f) => !f.split("/").some((p) => SKIP_DIRS.has(p)) && (o.hidden || !f.split("/").some((p) => p.startsWith(".")))), "git");
  }
  const files: string[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
      if (files.length > MOST_SCANNED) return;
      if (SKIP_DIRS.has(e.name) || (!o.hidden && e.name.startsWith("."))) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(dir, e.name), r); else if (e.isFile()) files.push(r);
    }
  };
  try { walk("", ""); } catch { /* an unreadable folder is left out */ }
  return cut(files, "walk");
}

function cut(files: string[], by: Listing["by"]): Listing {
  const all = files.map((f) => f.replace(/\\/g, "/").replace(/^\.\//, "")).filter(Boolean);
  return { files: all.slice(0, MOST_SCANNED), partial: all.length > MOST_SCANNED, by };
}
