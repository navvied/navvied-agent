import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import type { Tool } from "../types.ts";
import { clip, place, run, str } from "./util.ts";

/** Matches shown at most, and at most from one file when there are several: more than this is not read by a model, only paid for. */
const MOST_MATCHES = 100;
const PER_FILE = 50;
/** The most matches the program looks for itself, and the most output it takes from a search program, before it says "at least". */
const SEARCH_LIMIT = 20_000;
const OUTPUT_LIMIT = 400_000;

/**
 * Keeps the first matches (50 of a file when several files match, 100 in all) and says what it left out, so that a short list is
 * never taken for the whole. `partial`: the search itself stopped early, so there are at least as many as were counted.
 */
export function shortened(lines: string[], partial: boolean): string {
  const where = (l: string): string => /^(.+?):\d+:/.exec(l)?.[1] ?? "";
  const files = new Set(lines.map(where));
  const perFile = files.size === 1 ? MOST_MATCHES : PER_FILE;
  const seen = new Map<string, number>();
  const kept: string[] = [];
  const hidden = new Map<string, number>();
  for (const l of lines) {
    const f = where(l), n = (seen.get(f) ?? 0) + 1;
    seen.set(f, n);
    if (n <= perFile && kept.length < MOST_MATCHES) kept.push(l); else hidden.set(f, (hidden.get(f) ?? 0) + 1);
  }
  if (!hidden.size && !partial) return kept.join("\n");
  const more = [...hidden.values()].reduce((a, b) => a + b, 0);
  const inFiles = hidden.size > 1 ? ` in ${hidden.size} files` : hidden.size === 1 && files.size > 1 ? " in 1 file" : "";
  return `${kept.join("\n")}\n[${partial ? "at least " : ""}${more} more matches${inFiles} were not shown: narrow the pattern, add a glob, or search one file]`;
}

const SKIP_DIRS = new Set(["node_modules", ".git"]);
const MAX_FILE = 1_000_000;

/** The search done in-process, for machines with neither ripgrep nor grep (Windows, minimal containers). */
function searchHere(root: string, pattern: string, insensitive: boolean, only: string | undefined): { lines: string[]; partial: boolean } | string {
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
    const lines = text.split("\n");
    for (let i = 0; i < lines.length && out.length < SEARCH_LIMIT; i++) {
      if (regex.test(lines[i]!)) out.push(`${rel}:${i + 1}:${lines[i]!.replace(/\r$/, "").slice(0, 300)}`);
    }
    if (out.length >= SEARCH_LIMIT) return { lines: out, partial: true };
  }
  return { lines: out, partial: false };
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
    if (!Bun.which("rg", { PATH: path }) && !Bun.which("grep", { PATH: path })) { const found = searchHere(root, pattern, insensitive, a.glob ? str(a.glob) : undefined); return typeof found === "string" ? found : found.lines.length ? clip(shortened(found.lines, found.partial)) : "No matches."; }
    // The search runs in the folder searched, on ".", so each line starts with a short path of its own: a long temporary or project path in every line
    // would fill the output the search is allowed (400,000 characters) with nothing but paths, and the count of what was left out would be wrong.
    const directory = statSync(root).isDirectory();
    const base = directory ? root : dirname(root), target = directory ? "." : basename(root);
    const argv = Bun.which("rg", { PATH: path })
      ? ["rg", "-nH", "--no-heading", "--max-columns", "300", ...(insensitive ? ["-i"] : []), ...(a.glob ? ["-g", str(a.glob)] : []), "-e", pattern, target]
      : ["grep", "-rnHE", ...(insensitive ? ["-i"] : []), ...(a.glob ? ["--include", str(a.glob)] : []), "--exclude-dir=node_modules", "--exclude-dir=.git", "-e", pattern, target];
    const r = await run(argv, { cwd: base, signal: ctx.signal, timeoutMs: 30_000 });
    const text = r.output.trim();
    if (!text) return "No matches.";
    // Only lines that are matches (`file:line:text`) are matches: what the program says about a file it could not read, or a binary file, is not.
    const all = text.split("\n").map((l) => l.replace(/^\.[\\/]/, ""));
    const lines = all.filter((l) => /^.+?:\d+:/.test(l)).map((l) => (l.length > 300 ? `${l.slice(0, 300)}…` : l));
    if (!lines.length) return /^No matches/.test(text) ? "No matches." : `Error: ${text.slice(0, 300)}`;
    return clip(shortened(lines, r.output.length >= OUTPUT_LIMIT));
  },
};
