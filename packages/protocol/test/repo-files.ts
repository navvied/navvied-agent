import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/** The repository's own root, from wherever the tests are run. */
export const ROOT = resolve(import.meta.dir, "../../..");

/** Folders that are never the repository's own text: installed packages, build output, and git's own store. */
const NOT_OURS = new Set(["node_modules", ".git", "dist", "target"]);

/**
 * Every file of this checkout under 2 MB, for the repository-wide scans. Another checkout nested inside this one (a worktree,
 * whose root holds a `.git` file) is its own repository and is scanned there, so it is never walked into here.
 */
export function* repoFiles(dir = ROOT, skip: ReadonlySet<string> = new Set()): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (NOT_OURS.has(name) || skip.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) { if (!existsSync(join(p, ".git"))) yield* repoFiles(p, skip); }
    else if (st.size < 2_000_000) yield p;
  }
}
