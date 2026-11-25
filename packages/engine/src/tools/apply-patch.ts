import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import type { Tool, ToolContext } from "../types.ts";
import { wantsManyChanges } from "./edit-text.ts";
import { wrote } from "./file-state.ts";
import { decode, encode, forModel, writeAtomic, type Layout } from "./text-file.ts";
import { place, str } from "./util.ts";

/** One line of a change inside a file: kept (` `), taken out (`-`) or put in (`+`). */
interface Line { k: " " | "-" | "+"; t: string }
interface Chunk { context?: string; lines: Line[]; eof: boolean }
type Hunk =
  | { op: "add"; path: string; text: string }
  | { op: "delete"; path: string }
  | { op: "update"; path: string; moveTo?: string; chunks: Chunk[] };

const BEGIN = "*** Begin Patch", END = "*** End Patch", EOF_MARK = "*** End of File";
const header = (l: string, name: string): string | undefined => (l.startsWith(`*** ${name}: `) ? l.slice(name.length + 6).trim() : undefined);

/** The patch as hunks, or what is wrong with it. A patch wrapped in a shell heredoc (`<<'EOF'`) is taken as it is. */
export function parsePatch(text: string): Hunk[] | string {
  let lines = text.replace(/\r\n/g, "\n").trim().split("\n");
  if (/^<<['"]?EOF['"]?$/.test(lines[0] ?? "") && /EOF$/.test(lines.at(-1) ?? "")) lines = lines.slice(1, -1);
  if (lines[0]?.trim() !== BEGIN) return `the first line must be "${BEGIN}".`;
  if (lines.at(-1)?.trim() !== END) return `the last line must be "${END}".`;
  const body = lines.slice(1, -1), hunks: Hunk[] = [];
  for (let i = 0; i < body.length;) {
    const l = body[i]!;
    const add = header(l, "Add File"), del = header(l, "Delete File"), upd = header(l, "Update File");
    if (add !== undefined) {
      const rows: string[] = [];
      for (i++; i < body.length && body[i]!.startsWith("+"); i++) rows.push(body[i]!.slice(1));
      hunks.push({ op: "add", path: add, text: rows.length ? `${rows.join("\n")}\n` : "" });
    } else if (del !== undefined) { hunks.push({ op: "delete", path: del }); i++; }
    else if (upd !== undefined) {
      i++;
      const moveTo = header(body[i] ?? "", "Move to");
      if (moveTo !== undefined) i++;
      const chunks: Chunk[] = [];
      while (i < body.length && !/^\*\*\* (Add|Delete|Update) File: /.test(body[i]!)) {
        const chunk: Chunk = { lines: [], eof: false };
        if (body[i]!.startsWith("@@")) { const c = body[i]!.slice(2).trim(); if (c) chunk.context = c; i++; }
        while (i < body.length && !body[i]!.startsWith("@@") && !/^\*\*\* (Add|Delete|Update) File: /.test(body[i]!)) {
          const row = body[i]!;
          if (row === EOF_MARK) { chunk.eof = true; i++; break; }
          const k = row[0];
          if (k === "+" || k === "-" || k === " ") chunk.lines.push({ k, t: row.slice(1) });
          else if (row === "") chunk.lines.push({ k: " ", t: "" });
          else return `unexpected line in the changes to ${upd}: "${row.slice(0, 60)}". Each line must start with a space, "+" or "-".`;
          i++;
        }
        if (!chunk.lines.length && !chunk.context) return `the changes to ${upd} contain no lines.`;
        chunks.push(chunk);
      }
      if (!chunks.length && moveTo === undefined) return `"Update File: ${upd}" has no changes.`;
      hunks.push({ op: "update", path: upd, ...(moveTo !== undefined ? { moveTo } : {}), chunks });
    } else return `unexpected line: "${l.slice(0, 60)}". Expected "*** Add File: …", "*** Delete File: …" or "*** Update File: …".`;
  }
  return hunks.length ? hunks : "the patch changes no file.";
}

/** The files a patch would touch, for the permission rules that name files. */
export const patchPaths = (patch: unknown): string[] => {
  const hunks = parsePatch(str(patch));
  return typeof hunks === "string" ? [] : hunks.flatMap((h) => (h.op === "update" && h.moveTo ? [h.path, h.moveTo] : [h.path]));
};

const NORMAL: Record<string, string> = { "‐": "-", "‑": "-", "‒": "-", "–": "-", "—": "-", "―": "-", "−": "-", "‘": "'", "’": "'", "‚": "'", "‛": "'", "“": '"', "”": '"', "„": '"', "‟": '"', " ": " ", " ": " ", " ": " ", " ": " ", " ": " ", "　": " " };
const tidy = (s: string): string => s.trim().replace(/[‐-―−‘’‚‛“-‟     　]/g, (c) => NORMAL[c]!);

/** Where `pattern` is in `lines` at or after `start`: as written, then ignoring the ends of lines, then the whole indentation, then typographic punctuation (the order the original tool uses). With `eof` the end of the file is tried first. */
export function seek(lines: string[], pattern: string[], start: number, eof: boolean): number | undefined {
  if (!pattern.length) return start;
  if (pattern.length > lines.length) return undefined;
  const begin = eof ? Math.max(lines.length - pattern.length, start) : start;
  const same = (norm: (s: string) => string) => (i: number): boolean => pattern.every((p, k) => norm(lines[i + k]!) === norm(p));
  for (const norm of [(s: string) => s, (s: string) => s.trimEnd(), (s: string) => s.trim(), tidy]) {
    const at = same(norm);
    for (let i = begin; i + pattern.length <= lines.length; i++) if (at(i)) return i;
  }
  return undefined;
}

/** The lines of a file after the changes of one Update File, or what did not match. */
function update(path: string, original: string[], chunks: Chunk[]): string[] | string {
  const cuts: { at: number; len: number; put: string[] }[] = [];
  let from = 0;
  for (const c of chunks) {
    if (c.context !== undefined) {
      const at = seek(original, [c.context], from, false);
      if (at === undefined) return `Failed to find context '${c.context}' in ${path}.`;
      from = at + 1;
    }
    let lines = c.lines;
    if (!lines.some((l) => l.k !== "+")) { cuts.push({ at: original.length, len: 0, put: lines.map((l) => l.t) }); continue; }
    const old = (ls: Line[]): string[] => ls.filter((l) => l.k !== "+").map((l) => l.t);
    let at = seek(original, old(lines), from, c.eof);
    // A trailing empty line stands for the file's last newline, which is not a line here.
    if (at === undefined && lines.at(-1)?.t === "" && lines.at(-1)?.k === " ") { lines = lines.slice(0, -1); at = seek(original, old(lines), from, c.eof); }
    if (at === undefined) return `Failed to find the expected lines in ${path}:\n${old(lines).join("\n")}`;
    const put: string[] = [];
    let pos = at;
    // Lines that stay are the file's own, so a match that ignored spaces does not rewrite them.
    for (const l of lines) { if (l.k === "+") put.push(l.t); else { if (l.k === " ") put.push(original[pos]!); pos++; } }
    cuts.push({ at, len: pos - at, put });
    from = pos;
  }
  const out = [...original];
  for (const c of cuts.sort((x, y) => y.at - x.at)) out.splice(c.at, c.len, ...c.put);
  return out;
}

interface Step { path: string; before?: Buffer; after?: Buffer; to?: string; code: "A" | "M" | "D" }

const MOST_FILES = 50;

/** Applies a patch to every file it names, or to none: each result is worked out first, written next, and given back when a write fails. */
export function applyPatch(ctx: ToolContext, patch: string): string {
  const hunks = parsePatch(patch);
  if (typeof hunks === "string") return `Error: the patch is not valid: ${hunks} Nothing was changed.`;
  if (hunks.length > MOST_FILES) return `Error: the patch names ${hunks.length} files, more than ${MOST_FILES}. Nothing was changed.`;
  const steps: Step[] = [];
  const known = new Map<string, Buffer | undefined>();
  const current = (p: string): Buffer | undefined => (known.has(p) ? known.get(p) : existsSync(p) ? readFileSync(p) : undefined);
  try {
    for (const h of hunks) {
      const path = place(ctx, h.path);
      if (h.op === "add") {
        const after = Buffer.from(h.text);
        steps.push({ path, before: current(path), after, code: "A" }); known.set(path, after);
      } else if (h.op === "delete") {
        const before = current(path);
        if (!before) return `Error: ${h.path} does not exist, so it cannot be deleted. Nothing was changed.`;
        steps.push({ path, before, code: "D" }); known.set(path, undefined);
      } else {
        const before = current(path);
        if (!before) return `Error: ${h.path} does not exist, so it cannot be updated (use "*** Add File:" for a new file). Nothing was changed.`;
        const d = decode(before);
        if ("error" in d) return `Error: ${h.path} ${d.error} Nothing was changed.`;
        const text = forModel(d.text, d.layout);
        const rows = text.split("\n");
        const ended = rows.at(-1) === "" ? rows.pop() !== undefined : false;
        const next = update(h.path, rows, h.chunks);
        if (typeof next === "string") return `Error: ${next} Nothing was changed. Read the file again and copy the lines exactly.`;
        const layout: Layout = d.layout;
        const after = encode(`${next.join("\n")}${ended || next.length ? "\n" : ""}`, layout);
        const target = h.moveTo ? place(ctx, h.moveTo) : path;
        steps.push({ path, before, after, ...(target !== path ? { to: target } : {}), code: "M" });
        known.set(path, target !== path ? undefined : after);
        if (target !== path) known.set(target, after);
      }
    }
  } catch (e) { return `Error: ${e instanceof Error ? e.message : String(e)}. Nothing was changed.`; }

  const done: Step[] = [];
  try {
    for (const s of steps) {
      if (s.code === "D") rmSync(s.path);
      else { const where = s.to ?? s.path; mkdirSync(dirname(where), { recursive: true }); writeAtomic(where, s.after!); if (s.to) rmSync(s.path); }
      done.push(s);
    }
  } catch (e) {
    for (const s of done.reverse()) {
      try { if (s.to) rmSync(s.to, { force: true }); if (s.before) writeAtomic(s.path, s.before); else rmSync(s.path, { force: true }); } catch { /* the original is as it was before the patch, or as near as it could be given back */ }
    }
    return `Error: the patch could not be written (${e instanceof Error ? e.message : String(e)}); the files were put back as they were.`;
  }
  for (const s of steps) if (s.after) wrote(ctx, s.to ?? s.path, s.after);
  return `Success. Updated the following files:\n${steps.map((s) => `${s.code} ${s.to ?? s.path}`).join("\n")}`;
}

export type PatchMode = "auto" | "on" | "off";

export const applyPatchTool = (mode: PatchMode): Tool => ({
  name: "apply_patch",
  readOnly: false,
  description: 'Change several files at once, all or none. patch: "*** Begin Patch", then per file "*** Add File: p" (+lines), "*** Delete File: p" or "*** Update File: p" ("*** Move to: q"; "@@ line to find"; lines starting with space, - or +), "*** End Patch".',
  parameters: { type: "object", properties: { patch: { type: "string" } }, required: ["patch"] },
  offeredWhen: (s) => mode === "on" || (mode === "auto" && wantsManyChanges(s)),
  fixArgs: (a) => (typeof a.input === "string" && a.patch === undefined ? { patch: a.input } : a),
  title: () => "Apply a patch",
  async run(a, ctx) { return applyPatch(ctx, str(a.patch)); },
});
