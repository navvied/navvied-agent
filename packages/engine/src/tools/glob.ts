import { statSync } from "node:fs";
import { join } from "node:path";
import type { Tool } from "../types.ts";
import { listFiles } from "./file-list.ts";
import { clip, firstLines, place, str } from "./util.ts";

/** Files listed at most, the most recently changed first. */
const MOST_FILES = 100;

export const glob: Tool = {
  name: "Glob",
  readOnly: true,
  description: 'Find files: "src/**/*.ts".',
  parameters: {
    type: "object",
    properties: { pattern: { type: "string" }, path: { type: "string" } },
    required: ["pattern"],
  },
  title: (a) => `Find files: ${str(a.pattern)}`,
  async run(a, ctx) {
    const root = place(ctx, a.path ?? ".");
    const pattern = str(a.pattern);
    if (!pattern) return "Error: empty pattern.";
    const matcher = new Bun.Glob(pattern.replace(/^\.\//, ""));
    // Every file is looked at, then the matches are put in order of change and cut: cutting first would keep the first found, not the newest.
    const listing = await listFiles(root, { hidden: a.hidden === true || /(^|\/)\./.test(pattern), signal: ctx.signal });
    const found: { path: string; mtime: number }[] = [];
    for (const file of listing.files) {
      if (!matcher.match(file)) continue;
      try { found.push({ path: file, mtime: statSync(join(root, file)).mtimeMs }); } catch { /* vanished */ }
    }
    if (!found.length) return `No files matched.${listing.partial ? " The search stopped early: too many files; give a folder in path." : ""}`;
    found.sort((x, y) => y.mtime - x.mtime || (x.path < y.path ? -1 : 1));
    return clip(firstLines(found.map((f) => f.path).join("\n"), MOST_FILES, "files", "add a folder to the pattern or a narrower one") + (listing.partial ? "\n[the search stopped early: too many files]" : ""));
  },
};
