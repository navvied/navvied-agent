import { existsSync, statSync } from "node:fs";
import { basename, dirname } from "node:path";
import type { Tool } from "../types.ts";
import { searchHere, type Search } from "./grep-js.ts";
import { clip, num, place, run, str } from "./util.ts";

/** Matches shown at most, and at most from one file when there are several: more than this is not read by a model, only paid for. */
const MOST_MATCHES = 100;
const PER_FILE = 50;
/** The most output the program takes from a search program, before it says "at least". */
const OUTPUT_LIMIT = 400_000;

interface Page { offset: number; limit: number | undefined; /** The lines around a match are part of the output: they count and are never held back per file. */ context: boolean; noun: string }

/**
 * Keeps the first `limit` lines after `offset` (100 matches by default, and then 50 of a file when several files match) and says what it
 * left out and how to go on, so that a short list is never taken for the whole. `partial`: the search itself stopped early.
 */
export function shortened(all: string[], partial: boolean, page: Page = { offset: 0, limit: undefined, context: false, noun: "matches" }): string {
  const lines = all.slice(page.offset);
  const where = (l: string): string => /^(.+?):\d+:/.exec(l)?.[1] ?? "";
  const files = new Set(lines.map(where));
  const most = page.limit ?? MOST_MATCHES;
  const perFile = page.limit !== undefined || page.context ? most : files.size === 1 ? MOST_MATCHES : PER_FILE;
  const seen = new Map<string, number>();
  const kept: string[] = [];
  const hidden = new Map<string, number>();
  for (const l of lines) {
    const f = where(l), n = (seen.get(f) ?? 0) + 1;
    seen.set(f, n);
    if (n <= perFile && kept.length < most) kept.push(l); else hidden.set(f, (hidden.get(f) ?? 0) + 1);
  }
  const more = [...hidden.values()].reduce((a, b) => a + b, 0);
  if (!more && !partial) return kept.join("\n");
  const inFiles = hidden.size > 1 && !page.context ? ` in ${hidden.size} files` : hidden.size === 1 && files.size > 1 && !page.context ? " in 1 file" : "";
  const next = page.offset + kept.length;
  return `${kept.join("\n")}\n[${partial ? "at least " : ""}${more} more ${page.noun}${inFiles} were not shown: narrow the pattern, add a glob, search one file, or continue with offset ${next}]`;
}

/** A result longer than this ends with its own total. */
const COUNTED_FROM = 5;
const MODES = ["content", "files_with_matches", "count"] as const;
type Mode = (typeof MODES)[number];

/** The ways models spell the options of this tool, put into the names it has. */
const ALIASES: Record<string, string> = { "-i": "ignore_case", "-C": "context", "-A": "after", "-B": "before", head_limit: "limit", "-n": "" };

export const grep: Tool = {
  name: "Grep",
  readOnly: true,
  description: "Search files (ripgrep regex): file:line:text. Count many files by script.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string" },
      path: { type: "string" },
      glob: { type: "string" },
      ignore_case: { type: "boolean" },
      context: { type: "number" },
      output_mode: { type: "string" },
      limit: { type: "number" },
      offset: { type: "number" },
    },
    required: ["pattern"],
  },
  fixArgs: (a) => Object.fromEntries(Object.entries(a).flatMap(([k, v]) => (k in ALIASES ? (ALIASES[k] ? [[ALIASES[k]!, v]] : []) : [[k, v]]))),
  title: (a) => `Search: ${str(a.pattern)}`,
  async run(a, ctx) {
    const root = place(ctx, a.path ?? ".");
    const pattern = str(a.pattern).replace(/\\(["'])/g, "$1");
    if (!pattern) return "Error: empty pattern.";
    const mode: Mode = (MODES as readonly string[]).includes(str(a.output_mode)) ? (str(a.output_mode) as Mode) : "content";
    const count = (v: unknown): number => Math.min(20, Math.max(0, Math.floor(num(v, 0))));
    const context = count(a.context);
    const search: Search = { pattern, insensitive: a.ignore_case === true, multiline: a.multiline === true, before: context || count(a.before), after: context || count(a.after), mode, ...(a.glob ? { glob: str(a.glob) } : {}), ...(a.type ? { type: str(a.type) } : {}) };
    const page: Page = { offset: Math.max(0, Math.floor(num(a.offset, 0))), limit: a.limit === undefined ? undefined : Math.max(1, Math.floor(num(a.limit, MOST_MATCHES))), context: search.before + search.after > 0, noun: mode === "content" ? (search.before + search.after ? "lines" : "matches") : "files" };
    if (!existsSync(root)) return `Error: ${root} does not exist.`;
    const directory = statSync(root).isDirectory();

    let lines: string[], partial: boolean, note = "";
    const rg = Bun.which("rg", { PATH: process.env.PATH ?? "" });
    if (!rg) {
      const found = await searchHere(root, directory, search, ctx.signal);
      if (typeof found === "string") return found;
      ({ lines, partial } = found);
      // Said once per conversation: the model does not need the same sentence after every search.
      const told = ctx.keep?.("grep-without-ripgrep", () => ({ said: false, close() {} }));
      if (!told?.said) note = "\n[searched without ripgrep: patterns follow JavaScript's rules, which differ a little from ripgrep's]";
      if (told) told.said = true;
    } else {
      // The search runs in the folder searched, on ".", so each line starts with a short path of its own: a long temporary or project path in every line
      // would fill the output the search is allowed (400,000 characters) with nothing but paths, and the count of what was left out would be wrong.
      const base = directory ? root : dirname(root), target = directory ? "." : basename(root);
      const argv = ["rg", "--no-messages", "--color", "never", "--hidden", "-g", "!.git", "-g", "!node_modules", ...(mode === "files_with_matches" ? ["-l", "--sortr", "modified"] : mode === "count" ? ["-c", "-H", "--sort", "path"] : ["-nH", "--no-heading", "--sort", "path", "--max-columns", "300", ...(search.before ? ["-B", String(search.before)] : []), ...(search.after ? ["-A", String(search.after)] : [])]),
        ...(search.insensitive ? ["-i"] : []), ...(search.multiline ? ["-U", "--multiline-dotall"] : []), ...(search.glob ? ["-g", search.glob] : []), ...(search.type ? ["-t", search.type] : []), "-e", pattern, target];
      const r = await run(argv, { cwd: base, signal: ctx.signal, timeoutMs: 30_000 });
      const text = r.output.trim();
      if (!text) return "No matches.";
      const all = text.split("\n").map((l) => l.replace(/^\.[\\/]/, ""));
      // In the default mode only a `file:line:text` line is a match, or, with context, a line around one: what the program says about a file it could not read is not.
      lines = (mode === "content" ? all.filter((l) => (page.context ? /^(.+?[:-]\d+[:-]|--$)/ : /^.+?:\d+:/).test(l)) : all.filter((l) => (mode === "count" ? /^.+:\d+$/ : /./).test(l) && !/^rg: /.test(l))).map((l) => (l.length > 300 ? `${l.slice(0, 300)}…` : l));
      if (!lines.length) return /^No matches/.test(text) ? "No matches." : `Error: ${text.slice(0, 300)}`;
      partial = r.output.length >= OUTPUT_LIMIT;
    }
    if (!lines.length) return "No matches.";
    if (mode === "count") {
      const total = lines.reduce((n, l) => n + Number(/:(\d+)$/.exec(l)?.[1] ?? 0), 0);
      return clip(`${shortened(lines, partial, page)}\n[${total} matching lines in ${lines.length} files]${note}`);
    }
    // A long list is counted by the tool, not by eye: a model that counts lines of a search result gets the number wrong. One that is cut already says how many are left.
    const shown = shortened(lines, partial, page);
    const where = (l: string): string => /^(.+?):\d+:/.exec(l)?.[1] ?? "";
    const files = mode === "files_with_matches" ? lines.length : new Set(lines.map(where)).size;
    const counted = partial || page.context || page.offset > 0 || page.limit !== undefined || lines.length <= COUNTED_FROM || shown.includes("were not shown");
    const total = counted ? "" : mode === "files_with_matches" ? `\n[${files} files]` : `\n[${lines.length} matching lines in ${files} file${files === 1 ? "" : "s"}]`;
    return clip(shown + total + note);
  },
};
