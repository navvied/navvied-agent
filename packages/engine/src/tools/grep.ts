import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import type { Tool } from "../types.ts";
import { place, clip, run, str } from "./util.ts";

const SKIP_DIRS = new Set(["node_modules", ".git"]);
const MAX_FILE = 1_000_000;

/** The search done in-process, for machines with neither ripgrep nor grep (Windows, minimal containers). */
function searchHere(root: string, pattern: string, insensitive: boolean, only: string | undefined): string {
  let regex: RegExp;
  try { regex = new RegExp(pattern, insensitive ? "i" : ""); } catch { return "Error: the pattern is not a valid regular expression."; }
  const matcher = only ? new Bun.Glob(only) : undefined;
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((x, y) => (x.name < y.name ? -1 : 1))) {
      if (files.length >= 5000) return;
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(p); } else if (e.isFile()) files.push(p);
    }
  };
  if (statSync(root).isDirectory()) walk(root); else files.push(root);
  const base = statSync(root).isDirectory() ? root : join(root, "..");
  const out: string[] = [];
  for (const file of files) {
    const rel = relative(base, file).replace(/\\/g, "/");
    if (matcher && !matcher.match(only!.includes("/") ? rel : basename(file))) continue;
    let text: string;
    try { if (statSync(file).size > MAX_FILE) continue; text = readFileSync(file, "utf8"); } catch { continue; }
    if (text.includes("\u0000")) continue;
    let perFile = 0;
    const lines = text.split("\n");
    for (let i = 0; i < lines.length && perFile < 50 && out.length < 500; i++) {
      if (regex.test(lines[i]!)) { out.push(`${rel}:${i + 1}:${lines[i]!.replace(/\r$/, "").slice(0, 300)}`); perFile++; }
    }
    if (out.length >= 500) break;
  }
  return out.join("\n");
}

export const grep: Tool = {
  name: "Grep",
  readOnly: true,
  description: "Search file contents with a regular expression: file:line:text for each match.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string" },
      path: { type: "string" },
      glob: { type: "string" },
      ignore_case: { type: "boolean" },
    },
    required: ["pattern"],
  },
  title: (a) => `Search: ${str(a.pattern)}`,
  async run(a, ctx) {
    const root = place(ctx, a.path ?? ".");
    const pattern = str(a.pattern).replace(/\\(["'])/g, "$1");
    if (!pattern) return "Error: empty pattern.";
    const insensitive = a.ignore_case === true;
    const path = process.env.PATH ?? "";
    if (!Bun.which("rg", { PATH: path }) && !Bun.which("grep", { PATH: path })) return clip(searchHere(root, pattern, insensitive, a.glob ? str(a.glob) : undefined)) || "No matches.";
    const argv = Bun.which("rg", { PATH: path })
      ? ["rg", "-n", "--no-heading", "--max-columns", "300", "--max-count", "50", ...(insensitive ? ["-i"] : []), ...(a.glob ? ["-g", str(a.glob)] : []), "-e", pattern, root]
      : ["grep", "-rnE", ...(insensitive ? ["-i"] : []), ...(a.glob ? ["--include", str(a.glob)] : []), "--exclude-dir=node_modules", "--exclude-dir=.git", "-e", pattern, root];
    const r = await run(argv, { cwd: ctx.cwd, signal: ctx.signal, timeoutMs: 30_000 });
    const text = r.output.trim();
    if (!text) return "No matches.";
    return clip(text.split("\n").map((l) => l.replace(`${root}/`, "").replace(`${root}\\`, "")).join("\n"));
  },
};
