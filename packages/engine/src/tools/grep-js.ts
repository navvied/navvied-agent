import { readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { listFiles } from "./file-list.ts";

/** What a search looks for, in the words of the Grep tool. */
export interface Search { pattern: string; insensitive: boolean; glob?: string; type?: string; multiline: boolean; before: number; after: number; mode: "content" | "files_with_matches" | "count" }

/** The answer of a search made here: lines as ripgrep prints them (`file:line:text` for a match, `file-line-text` for the lines around it), or a message. */
export type Found = { lines: string[]; partial: boolean } | string;

const SEARCH_LIMIT = 20_000;
const MAX_FILE = 5_000_000;
/** The file types the `type` option knows when there is no ripgrep to say. */
const TYPES: Record<string, string[]> = { ts: ["ts", "tsx", "mts", "cts"], js: ["js", "jsx", "mjs", "cjs"], py: ["py", "pyi"], rust: ["rs"], go: ["go"], java: ["java"], c: ["c", "h"], cpp: ["cpp", "cc", "cxx", "hpp", "hh", "h"], md: ["md", "markdown"], json: ["json"], yaml: ["yaml", "yml"], html: ["html", "htm"], css: ["css", "scss"], sh: ["sh", "bash"], rb: ["rb"], php: ["php"], swift: ["swift"], kotlin: ["kt", "kts"], sql: ["sql"], toml: ["toml"] };

/** The search done in this program, for a computer with no ripgrep. It follows `.gitignore` as far as git does, and its patterns are JavaScript's, not ripgrep's: the result says so. */
export async function searchHere(root: string, dir: boolean, s: Search, signal: AbortSignal): Promise<Found> {
  let regex: RegExp;
  try { regex = new RegExp(s.pattern, `g${s.insensitive ? "i" : ""}m${s.multiline ? "s" : ""}`); } catch { return "Error: the pattern is not a valid regular expression."; }
  if (s.type && !TYPES[s.type]) return `Error: unknown file type "${s.type}". Known: ${Object.keys(TYPES).join(", ")}.`;
  const only = s.glob ? new Bun.Glob(s.glob) : undefined;
  const exts = s.type ? TYPES[s.type]! : undefined;
  const listing = dir ? await listFiles(root, { hidden: true, signal }) : { files: [basename(root)], partial: false };
  const base = dir ? root : join(root, "..");
  const out: string[] = [];
  let partial = listing.partial;
  for (const file of [...listing.files].sort()) {
    if (only && !only.match(s.glob!.includes("/") ? file : basename(file))) continue;
    if (exts && !exts.includes(file.slice(file.lastIndexOf(".") + 1).toLowerCase())) continue;
    let text: string;
    try { if (statSync(join(base, file)).size > MAX_FILE) continue; text = readFileSync(join(base, file), "utf8"); } catch { continue; }
    if (text.slice(0, 8000).includes("\u0000")) continue;
    const lines = text.split("\n");
    if (lines.at(-1) === "") lines.pop();
    const hit = new Set<number>();
    if (s.multiline) {
      const starts: number[] = [];
      let at = 0;
      for (const l of lines) { starts.push(at); at += l.length + 1; }
      const lineAt = (i: number): number => { let lo = 0, hi = starts.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (starts[m]! <= i) lo = m; else hi = m - 1; } return lo; };
      for (const m of text.matchAll(regex)) { for (let n = lineAt(m.index!); n <= lineAt(m.index! + Math.max(0, m[0].length - 1)); n++) hit.add(n); if (!m[0]) regex.lastIndex++; }
    } else {
      const one = new RegExp(regex.source, regex.flags.replace("g", ""));
      lines.forEach((l, n) => { if (one.test(l)) hit.add(n); });
    }
    if (!hit.size) continue;
    if (s.mode === "files_with_matches") { out.push(file); continue; }
    if (s.mode === "count") { out.push(`${file}:${hit.size}`); continue; }
    const shown = new Set<number>();
    for (const n of hit) for (let k = Math.max(0, n - s.before); k <= Math.min(lines.length - 1, n + s.after); k++) shown.add(k);
    let last = -2;
    for (const n of [...shown].sort((x, y) => x - y)) {
      // Groups are told apart as ripgrep does it: by a line, also between two files.
      if ((s.before || s.after) && out.length && n !== last + 1) out.push("--");
      out.push(`${file}${hit.has(n) ? ":" : "-"}${n + 1}${hit.has(n) ? ":" : "-"}${lines[n]!.replace(/\r$/, "").slice(0, 300)}`);
      last = n;
    }
    if (out.length >= SEARCH_LIMIT) { partial = true; break; }
  }
  return { lines: out, partial };
}
