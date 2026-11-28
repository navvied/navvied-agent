import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
export const ROOT = resolve(import.meta.dir, "../../..");
const NOT_OURS = new Set(["node_modules", ".git", "dist", "target"]);
export function* repoFiles(dir = ROOT, skip: ReadonlySet<string> = new Set()): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (NOT_OURS.has(name) || skip.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) { if (!existsSync(join(p, ".git"))) yield* repoFiles(p, skip); }
    else if (st.size < 2_000_000) yield p;
  }
}

const LOCKFILES = new Set(["bun.lock", "bun.lockb"]);

export function hitsOf(terms: string[], allowed: Set<string>): string[] {
  const hits: string[] = [];
  for (const f of repoFiles(ROOT, LOCKFILES)) {
    const path = relative(ROOT, f).replaceAll(sep, "/");
    if (allowed.has(path)) continue;
    const text = readFileSync(f, "utf8").toLowerCase();
    for (const term of terms) if (text.includes(term) || path.toLowerCase().includes(term)) hits.push(`${path}: "${term}"`);
  }
  return hits;
}
