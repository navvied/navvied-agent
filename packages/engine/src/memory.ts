/**
 * Memory: short notes the agent keeps for later, in a plain file the person can read and edit. One file is for every
 * project (in the person's navvied folder), one is for a project (`.navvied/memory.md` in it). Both are read at the start of
 * each conversation, together with the instructions.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

export const MEMORY_FILE = "memory.md";
export const PROJECT_MEMORY = join(".navvied", MEMORY_FILE);
export const MEMORY_LIMIT = 20_000;
const NOTE_LIMIT = 500;

export interface MemoryPaths {
  /** Notes for every project. Absent when there is no folder of the person's own. */
  user?: string;
  /** Notes for this project. */
  project: string;
}

export type Scope = "project" | "user";

/** Adds one note. Returns what to tell the model: that it was kept, or why it was not. */
export function remember(paths: MemoryPaths, scope: Scope, note: string, today: string): string {
  const text = note.replace(/\s+/g, " ").trim();
  if (!text) return "Error: the note is empty.";
  if (text.length > NOTE_LIMIT) return `Error: a note is at most ${NOTE_LIMIT} characters. Keep it short, one fact.`;
  const file = scope === "user" ? paths.user : paths.project;
  if (!file) return "Error: there is no place for notes for every project on this computer.";
  try {
    if (existsSync(file) && statSync(file).size > MEMORY_LIMIT) return "Error: the memory file is full. Ask the user to tidy it, or to open it with /memory.";
    if (readNotes(file).split("\n").some((l) => l.endsWith(`- ${text}`) || l.includes(`: ${text}`))) return "That is already remembered.";
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${existsSync(file) && statSync(file).size > 0 ? "" : "# What navvied remembers\n\n"}- ${today}: ${text}\n`);
    return `Remembered for ${scope === "user" ? "every project" : "this project"}: ${text}`;
  } catch (e) { return `Error: could not write the note: ${e instanceof Error ? e.message : String(e)}`; }
}

export function readNotes(file: string | undefined): string {
  if (!file) return "";
  try { return existsSync(file) ? readFileSync(file, "utf8") : ""; } catch { return ""; }
}

/** The notes as they are put in front of the model at the start of a conversation. */
export function memoryText(paths: MemoryPaths): string | undefined {
  const parts = [["Notes you kept for every project", paths.user], ["Notes you kept for this project", paths.project]] as const;
  const blocks = parts.flatMap(([title, file]) => { const t = readNotes(file).replace(/^# .*\n+/, "").trim(); return t ? [`# ${title}\n${t.slice(-MEMORY_LIMIT)}`] : []; });
  return blocks.length ? blocks.join("\n\n") : undefined;
}

export const memoryFolder = (project: string): string => join(project, ".navvied");
