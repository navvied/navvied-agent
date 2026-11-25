/**
 * Memory: short notes the agent keeps for later, in a plain file the person can read and edit. One file is for every
 * project (in the person's navvied folder), one is for a project (`.navvied/memory.md` in it). Both are read at the start of
 * each conversation, together with the instructions.
 *
 * A note is one line, `- 2026-11-16: the fact`, and may end in a hidden marker `<!--id origin-->` that gives it a stable id and says
 * where it came from (`user` typed or edited by the person, `self` the agent's own idea, `web` written in a turn that read web text).
 * A line without a marker (an older file, a hand-written note) still loads; its id is made from its text, and it counts as the person's.
 * Changes keep every other line exactly as it is, and a file is replaced only if nobody else changed it meanwhile.
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { clean, scanText } from "./text-scan.ts";

export const MEMORY_FILE = "memory.md";
export const PROJECT_MEMORY = join(".navvied", MEMORY_FILE);
/** The notes of one file that are put in front of the model (and the most a file may hold when the agent adds to it). */
export const MEMORY_LIMIT = 6_000;
const NOTE_LIMIT = 500;
const HEADER = "# What navvied remembers\n\n";

export interface MemoryPaths {
  /** Notes for every project. Absent when there is no folder of the person's own. */
  user?: string;
  /** Notes for this project. */
  project: string;
}

export type Scope = "project" | "user";
export type Origin = "user" | "self" | "web";

export interface Entry { id: string; date: string; text: string; origin: Origin; /** The line as it is in the file. */ line: string; /** Whether the line carries its own id (an older line does not). */ marked: boolean }

const LINE = /^- (\d{4}-\d{2}-\d{2}): (.*?)(?:\s*<!--([a-z0-9]{4,12})(?: (self|web|user))?-->)?\s*$/;

export function parseEntries(raw: string): Entry[] {
  const out: Entry[] = [];
  for (const line of raw.split("\n")) {
    const m = LINE.exec(line.replace(/\r$/, ""));
    if (!m) continue;
    out.push({ id: m[3] ?? `h${createHash("sha1").update(`${m[1]}${m[2]}`).digest("hex").slice(0, 5)}`, date: m[1]!, text: m[2]!, origin: (m[4] as Origin | undefined) ?? "user", line, marked: m[3] !== undefined });
  }
  return out;
}

const lineOf = (e: Pick<Entry, "id" | "date" | "text" | "origin">): string => `- ${e.date}: ${e.text} <!--${e.id}${e.origin === "user" ? "" : ` ${e.origin}`}-->`;
const label = (e: Entry): string => `${e.id}: ${e.text.length > 70 ? `${e.text.slice(0, 69)}…` : e.text}`;
const words = (t: string): Set<string> => new Set(t.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
/** The share of the first set's words that the second has. */
const shared = (a: Set<string>, b: Set<string>): number => { let n = 0; for (const w of a) if (b.has(w)) n++; return n / Math.max(1, a.size); };
const overlap = (a: Set<string>, b: Set<string>): number => { let n = 0; for (const w of a) if (b.has(w)) n++; return n / Math.max(1, a.size + b.size - n); };

export function readNotes(file: string | undefined): string {
  if (!file) return "";
  try { return existsSync(file) ? readFileSync(file, "utf8") : ""; } catch { return ""; }
}

export interface Pending { id: string; scope: Scope; action: "add" | "replace" | "forget"; text: string; target?: string; origin: Origin; at: number }
export type MemoryOp = { action: "add"; scope: Scope; text: string } | { action: "replace"; scope: Scope; target: string; text: string } | { action: "forget"; scope: Scope; target: string };
export interface MemoryWho { today: string; origin: Origin; /** Keep it for the person to accept instead of applying it. */ stage?: boolean }

const fileOf = (paths: MemoryPaths, scope: Scope): string | undefined => (scope === "user" ? paths.user : paths.project);
const pendingFile = (file: string): string => file.replace(/\.md$/, "") + ".pending.json";
const placeName = (scope: Scope): string => (scope === "user" ? "every project" : "this project");

/** Writes a whole file in one step, keeping the old one as `.bak`, and only if the file is still what it was when it was read. */
function replaceFile(file: string, was: string, next: string, backup: boolean): string | undefined {
  mkdirSync(dirname(file), { recursive: true });
  if ((existsSync(file) ? readFileSync(file, "utf8") : "") !== was) return "Error: the memory file changed while you were editing it. Try again.";
  if (backup && was) copyFileSync(file, `${file}.bak`);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, next);
  renameSync(tmp, file);
  return undefined;
}

/** The notes that could be made shorter, longest first, for a message that asks the model to tidy. */
const longest = (entries: Entry[]): string => [...entries].sort((a, b) => b.text.length - a.text.length).slice(0, 4).map(label).join("; ");

function newId(taken: Set<string>): string {
  for (;;) { const id = Math.random().toString(36).slice(2, 8).padEnd(6, "0"); if (!taken.has(id)) return id; }
}

function find(entries: Entry[], target: string): Entry | string {
  const t = target.trim();
  const byId = entries.find((e) => e.id === t);
  if (byId) return byId;
  const hits = entries.filter((e) => e.text.toLowerCase().includes(t.toLowerCase()) && t.length >= 2);
  if (hits.length === 1) return hits[0]!;
  if (hits.length > 1) return `Error: "${t}" matches ${hits.length} notes. Use the id of one: ${hits.slice(0, 4).map(label).join("; ")}.`;
  const close = entries.map((e) => [shared(words(t), words(e.text)), e] as const).filter(([s]) => s >= 0.4).sort((a, b) => b[0] - a[0]).slice(0, 3);
  return `Error: no note matches "${t}".${close.length ? ` Closest: ${close.map(([, e]) => label(e)).join("; ")}.` : entries.length ? ` Ids: ${entries.slice(-4).map(label).join("; ")}.` : " Nothing is kept there yet."}`;
}

/** Adds, replaces or forgets one note. Returns what to tell the model: that it was done, or why it was not and what to do. */
export function keep(paths: MemoryPaths, op: MemoryOp, who: MemoryWho): string {
  const file = fileOf(paths, op.scope);
  if (!file) return "Error: there is no place for notes for every project on this computer.";
  let text = "";
  if (op.action !== "forget") {
    const found = scanText(op.text);
    if (found.length) return `Error: not kept, the note has ${found.join(", ")}. A note is a plain fact about the person or the project.`;
    text = clean(op.text.replace(/\s+/g, " ").trim());
    if (!text) return "Error: the note is empty.";
    if (text.length > NOTE_LIMIT) return `Error: a note is at most ${NOTE_LIMIT} characters. Keep it short, one fact.`;
  }
  if (who.stage) return stage(file, op, text, who);
  try {
    const was = readNotes(file), entries = parseEntries(was);
    const mine = op.action === "add" ? undefined : find(entries, op.target);
    if (typeof mine === "string") return mine;
    if (op.action !== "forget") {
      const same = entries.find((e) => e !== mine && (words(e.text).size ? overlap(words(e.text), words(text)) >= 0.85 : false));
      if (same) return `That is already remembered (${label(same)}). To change it, use replace with target ${same.id}.`;
      const size = entries.filter((e) => e !== mine).reduce((n, e) => n + e.text.length + 14, 0) + text.length + 14;
      if (size > MEMORY_LIMIT) return `Error: the notes for ${placeName(op.scope)} are full (${MEMORY_LIMIT} characters). Shorten or forget some first, for example the longest: ${longest(entries)}.`;
    }
    const entry = { id: mine?.marked ? mine.id : newId(new Set(entries.map((e) => e.id))), date: who.today, text, origin: who.origin };
    let next: string;
    if (op.action === "add") next = `${was && !was.endsWith("\n") ? `${was}\n` : was || HEADER}${lineOf(entry)}\n`;
    else if (op.action === "replace") next = was.replace(mine!.line, () => lineOf(entry));
    else next = was.split("\n").filter((l) => l !== mine!.line).join("\n");
    const failed = replaceFile(file, was, next, op.action !== "add");
    if (failed) return failed;
    if (op.action === "forget") return `Forgot for ${placeName(op.scope)}: ${mine!.text}`;
    return `${op.action === "add" ? "Remembered" : "Replaced"} for ${placeName(op.scope)} (id ${entry.id}): ${text}`;
  } catch (e) { return `Error: could not write the note: ${e instanceof Error ? e.message : String(e)}`; }
}

function stage(file: string, op: MemoryOp, text: string, who: MemoryWho): string {
  try {
    const list = pendingOf(file);
    list.push({ id: `p${Math.random().toString(36).slice(2, 7)}`, scope: op.scope, action: op.action, text, ...("target" in op ? { target: op.target } : {}), origin: who.origin, at: Date.now() });
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(pendingFile(file), JSON.stringify(list.slice(-50)));
    return `Not kept yet: it came from a page on the web, so the person is asked first (${op.action}: ${text || ("target" in op ? op.target : "")}).`;
  } catch (e) { return `Error: could not stage the note: ${e instanceof Error ? e.message : String(e)}`; }
}

function pendingOf(file: string): Pending[] {
  try { const raw = JSON.parse(readFileSync(pendingFile(file), "utf8")) as unknown; return Array.isArray(raw) ? (raw as Pending[]) : []; } catch { return []; }
}

/** Everything waiting for the person, in both places. */
export const pendingNotes = (paths: MemoryPaths): Pending[] => [paths.project, paths.user].flatMap((f) => (f ? pendingOf(f) : []));

/** The person's answer to one waiting note. Accepting applies it (still marked as from the web); either way it leaves the list. */
export function resolvePending(paths: MemoryPaths, id: string, accept: boolean, today: string): string {
  for (const file of [paths.project, paths.user]) {
    if (!file) continue;
    const list = pendingOf(file), p = list.find((x) => x.id === id);
    if (!p) continue;
    const rest = list.filter((x) => x !== p);
    writeFileSync(pendingFile(file), JSON.stringify(rest));
    if (!accept) return "Dropped.";
    return keep(paths, p.action === "add" ? { action: "add", scope: p.scope, text: p.text } : p.action === "replace" ? { action: "replace", scope: p.scope, target: p.target ?? "", text: p.text } : { action: "forget", scope: p.scope, target: p.target ?? "" }, { today, origin: p.origin });
  }
  return `Error: nothing waiting with id ${id}.`;
}

/** One note as it is put in front of the model: no id, and a mark on what came from the web. A note that fails the scan is not shown. */
function shown(e: Entry): string {
  const found = scanText(e.text);
  return found.length ? `- ${e.date}: [hidden: ${found[0]}; ask the person to check the notes file]` : `- ${e.date}: ${clean(e.text)}${e.origin === "web" ? " (from a web page)" : ""}`;
}

/** The notes as they are put in front of the model at the start of a conversation: the newest that fit. */
export function memoryText(paths: MemoryPaths): string | undefined {
  const parts = [["Notes you kept for every project", paths.user], ["Notes you kept for this project", paths.project]] as const;
  const blocks = parts.flatMap(([title, file]) => {
    const rows = parseEntries(readNotes(file)).map(shown);
    if (!rows.length) return [];
    const kept: string[] = [];
    let used = 0;
    for (const r of rows.reverse()) { if (used + r.length > MEMORY_LIMIT && kept.length) break; kept.unshift(r); used += r.length + 1; }
    return [`# ${title}\n${kept.join("\n")}${kept.length < rows.length ? `\n(${rows.length - kept.length} older notes are not shown)` : ""}`];
  });
  return blocks.length ? blocks.join("\n\n") : undefined;
}

export const memoryFolder = (project: string): string => join(project, ".navvied");
