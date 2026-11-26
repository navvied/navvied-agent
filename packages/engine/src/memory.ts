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
import type { EngineEvent } from "@navvied/protocol";
import { fuse } from "./embeddings.ts";
import { clean, scanText } from "./text-scan.ts";
import { alike, terms } from "./text-match.ts";

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
/** Where a suggested note was taken from: the person's own message, a file, a web page, or the result of a tool. */
export type NoteSource = "message" | "file" | "web" | "tool";

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
const overlap = (a: Set<string>, b: Set<string>): number => { let n = 0; for (const w of a) if (b.has(w)) n++; return n / Math.max(1, a.size + b.size - n); };

export function readNotes(file: string | undefined): string {
  if (!file) return "";
  try { return existsSync(file) ? readFileSync(file, "utf8") : ""; } catch { return ""; }
}

export interface Pending { id: string; scope: Scope; action: "add" | "replace" | "forget"; text: string; target?: string; origin: Origin; source: NoteSource; /** The message of the conversation it was taken from (1-based). */ n?: number; at: number }
export type MemoryOp = { action: "add"; scope: Scope; text: string } | { action: "replace"; scope: Scope; target: string; text: string } | { action: "forget"; scope: Scope; target: string };
export interface MemoryWho { today: string; origin: Origin; /** Keep it for the person to accept instead of applying it. */ stage?: boolean; source?: NoteSource; n?: number }

/** The most notes put in front of the model for one request, and the most characters they may take. */
export const NOTES_PER_TURN = 5;
export const NOTES_BUDGET = 1_500;

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
  // Words with a slip in them ("stagng server") still point at the one note they are closest to, when it is clearly the closest.
  const asked = keywords(t);
  const ranked = entries.map((e) => [asked.size ? matched(asked, keywords(e.text)) / asked.size : 0, e] as const).sort((a, b) => b[0] - a[0]);
  if (ranked[0] && ranked[0][0] >= 0.6 && ranked[0][0] > (ranked[1]?.[0] ?? 0)) return ranked[0][1];
  const close = ranked.filter(([s]) => s >= 0.4).slice(0, 3);
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
    text = clean(op.text.replace(/\s+/g, " ").trim()).replace(/^\d{4}-\d{2}-\d{2}: +/, "");
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
    list.push({ id: `p${Math.random().toString(36).slice(2, 7)}`, scope: op.scope, action: op.action, text, ...("target" in op ? { target: op.target } : {}), origin: who.origin, source: who.source ?? (who.origin === "web" ? "web" : "tool"), ...(who.n ? { n: who.n } : {}), at: Date.now() });
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(pendingFile(file), JSON.stringify(list.slice(-50)));
    return `Not kept yet: the person is asked first (${op.action}: ${text || ("target" in op ? op.target : "")}).`;
  } catch (e) { return `Error: could not stage the note: ${e instanceof Error ? e.message : String(e)}`; }
}

function pendingOf(file: string): Pending[] {
  try { const raw = JSON.parse(readFileSync(pendingFile(file), "utf8")) as unknown; return Array.isArray(raw) ? (raw as Pending[]) : []; } catch { return []; }
}

/** Everything waiting for the person, in both places. */
export const pendingNotes = (paths: MemoryPaths): Pending[] => [paths.project, paths.user].flatMap((f) => (f ? pendingOf(f) : []));

/** The list of waiting notes as the protocol says it (`memory.pending`). */
export const pendingEvent = (paths: MemoryPaths): Extract<EngineEvent, { ev: "memory.pending" }> => {
  const items = pendingNotes(paths).map(({ id, scope, action, text, target, origin, source, n, at }) => ({ id, scope, action, text, ...(target ? { target } : {}), origin, source: source ?? (origin === "web" ? "web" as const : "tool" as const), ...(n ? { n } : {}), at }));
  return { ev: "memory.pending", count: items.length, items };
};

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
const plainText = (e: Entry): string => {
  const found = scanText(e.text);
  return found.length ? `[hidden: ${found[0]}; ask the person to check the notes file]` : clean(e.text);
};
const noteText = (e: Entry): string => `${plainText(e)}${e.origin === "web" && !scanText(e.text).length ? " (from a web page)" : ""}`;
const shown = (e: Entry): string => `- ${e.date}: ${noteText(e)}`;

/** The words of a text that can tell one note from another (a one-letter word says nothing). */
const keywords = (t: string): Set<string> => new Set(terms(t).filter((w) => w.length >= 2));
/** How many of the words asked are in the note, as the same word, its start, or one slip away from it. */
const matched = (asked: ReadonlySet<string>, note: ReadonlySet<string>): number => [...asked].filter((a) => [...note].some((w) => alike(a, w))).length;

/** The text of every note of both places, as `memoryText` takes it into account. */
export const noteTexts = (paths: MemoryPaths): string[] => (["user", "project"] as const).flatMap((s) => parseEntries(readNotes(fileOf(paths, s))).map((e) => e.text));

/** Every note of both places as a page lists them: the text the model is shown, without its mark for the web (a note that fails the scan is hidden), and the id to edit or forget it by. */
export const noteItems = (paths: MemoryPaths, scope?: Scope): { id: string; scope: Scope; date: string; text: string; origin: Origin }[] =>
  (["user", "project"] as const).filter((s) => !scope || s === scope).flatMap((s) => parseEntries(readNotes(fileOf(paths, s))).map((e) => ({ id: e.id, scope: s, date: e.date, text: plainText(e), origin: e.origin })));

/** Every note of both places, as `list` shows them to the model: the id to replace or forget it by, and where it is kept. */
export function listNotes(paths: MemoryPaths, scope?: Scope): string {
  const rows = (["user", "project"] as const).filter((s) => !scope || s === scope).flatMap((s) => parseEntries(readNotes(fileOf(paths, s))).map((e) => `- ${e.id} (${s === "user" ? "every project" : "this project"}, ${e.date}): ${noteText(e)}`));
  return rows.length ? rows.join("\n") : "No notes are kept yet.";
}

/**
 * The notes as they are put in front of the model. Without a request: the newest that fit, from the start of a conversation.
 * With the request: at most NOTES_PER_TURN notes in NOTES_BUDGET characters, the ones that share the most words with it (newest first
 * among equals), so a long list of notes never fills the prompt; the others are one `Remember` call away. `meaning` is, when a server that
 * reads meaning is set up, how alike each note's text is to the request; it is fused with the words and does not replace them.
 */
export function memoryText(paths: MemoryPaths, request?: string, meaning?: ReadonlyMap<string, number>): string | undefined {
  const parts = [["Notes you kept for every project", paths.user], ["Notes you kept for this project", paths.project]] as const;
  if (request !== undefined) return relevantText(parts, request, meaning);
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

function relevantText(parts: readonly (readonly [string, string | undefined])[], request: string, meaning?: ReadonlyMap<string, number>): string | undefined {
  const asked = keywords(request);
  const all = parts.flatMap(([title, file]) => parseEntries(readNotes(file)).map((e, at) => ({ title, row: shown(e), words: matched(asked, keywords(e.text)), like: meaning?.get(e.text), at })));
  if (!all.length) return undefined;
  const ids = (xs: readonly (typeof all)[number][]): string[] => xs.map((x) => String(all.indexOf(x)));
  const fused = fuse([ids(all.filter((n) => n.words > 0).sort((a, b) => b.words - a.words || b.at - a.at)), ids(all.filter((n) => n.like !== undefined).sort((a, b) => b.like! - a.like!))]);
  const score = (n: (typeof all)[number]): number => fused.get(String(all.indexOf(n))) ?? 0;
  const chosen: typeof all = [];
  let used = 0;
  for (const n of [...all].sort((a, b) => score(b) - score(a) || b.at - a.at)) {
    if (chosen.length >= NOTES_PER_TURN || (used + n.row.length > NOTES_BUDGET && chosen.length)) break;
    chosen.push(n);
    used += n.row.length + 1;
  }
  const blocks = parts.flatMap(([title]) => {
    const mine = chosen.filter((n) => n.title === title).sort((a, b) => a.at - b.at);
    return mine.length ? [`# ${title}\n${mine.map((n) => n.row).join("\n")}`] : [];
  });
  const left = all.length - chosen.length;
  return `${blocks.join("\n\n")}${left ? `\n(${left} more notes: Remember with action list shows them)` : ""}`;
}

export const memoryFolder = (project: string): string => join(project, ".navvied");
