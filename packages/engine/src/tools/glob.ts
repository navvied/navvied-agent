import { statSync } from "node:fs";
import { join } from "node:path";
import type { Tool } from "../types.ts";
import { clip, firstLines, place, str } from "./util.ts";

/** Files listed at most, the most recently changed first. */
const MOST_FILES = 100;
const SKIP = /(^|\/)(node_modules|\.git)\//;

export const glob: Tool = {
  name: "Glob",
  readOnly: true,
  description: 'Find files by pattern, such as "src/**/*.ts".',
  parameters: {
    type: "object",
    properties: { pattern: { type: "string" }, path: { type: "string" } },
    required: ["pattern"],
  },
  title: (a) => `Find files: ${str(a.pattern)}`,
  async run(a, ctx) {
    const root = place(ctx, a.path ?? ".");
    const found: { path: string; mtime: number }[] = [];
    for await (const scanned of new Bun.Glob(str(a.pattern)).scan({ cwd: root, onlyFiles: true })) {
      const file = scanned.replace(/\\/g, "/");
      if (SKIP.test(file)) continue;
      try { found.push({ path: file, mtime: statSync(join(root, file)).mtimeMs }); } catch { /* vanished */ }
      if (found.length >= 2000) break;
    }
    if (!found.length) return "No files matched.";
    found.sort((x, y) => y.mtime - x.mtime);
    return clip(firstLines(found.map((f) => f.path).join("\n"), MOST_FILES, "files", "add a folder to the pattern or a narrower one"));
  },
};
