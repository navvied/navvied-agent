import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { defaultTools, type Tool } from "@navvied/engine";
import type { ToolEntry, ToolInfo, ToolSetInfo, ToolState } from "@navvied/protocol";
import { CATEGORIES, TOOL_ROWS, rowOf, type ToolRow } from "./tool-table.ts";
import type { PluginState } from "./plugins.ts";

type Access = ToolInfo["access"];
/** The words a person reads about each tool of the agent, and the set it belongs to. The tools themselves are in the engine; this is only how they are shown. */
const WORDS: Record<string, { title: string; about: string; access: Access; set: string; core?: true; small?: true }> = {
  Read: { title: "Read files", about: "Looks inside a file or a folder.", access: "read", set: "files", core: true, small: true },
  Write: { title: "Write files", about: "Creates a file, or replaces one.", access: "change", set: "files", core: true, small: true },
  Edit: { title: "Edit files", about: "Changes part of a file and leaves the rest alone.", access: "change", set: "files", core: true, small: true },
  Glob: { title: "Find files", about: "Finds files by their name.", access: "read", set: "files", core: true, small: true },
  Grep: { title: "Search inside files", about: "Finds the files that hold a word or a phrase.", access: "read", set: "files", core: true, small: true },
  Bash: { title: "Run commands", about: "Runs a command in the terminal, and long ones in the background.", access: "run", set: "terminal", core: true, small: true },
  BashOutput: { title: "Read a background command", about: "Reads what a command running in the background has printed.", access: "read", set: "terminal" },
  BashInput: { title: "Type to a running program", about: "Types to a program that asks questions or waits for input, such as a REPL or an installer.", access: "run", set: "terminal" },
  KillShell: { title: "Stop a background command", about: "Stops a command that keeps running.", access: "run", set: "terminal" },
  WebFetch: { title: "Open a web address", about: "Reads the page behind a link.", access: "web", set: "web" },
  WebSearch: { title: "Search the web", about: "Looks something up online. Offered when you ask for it.", access: "web", set: "web" },
  Browser: { title: "Use a browser", about: "Opens a page, reads it, and clicks and types for you. Offered when you ask for it.", access: "web", set: "web" },
  Skill: { title: "Use a skill", about: "Follows the written steps of a skill you have installed.", access: "read", set: "helpers" },
  Agent: { title: "Hand work to a helper", about: "Gives a part of the job to a helper with its own conversation.", access: "read", set: "helpers" },
  Recall: { title: "Look through earlier conversations", about: "Finds what was said in your earlier conversations and reads one. Offered when you refer to something from before.", access: "read", set: "notes" },
  Remember: { title: "Remember", about: "Keeps a note for later conversations on this computer.", access: "change", set: "notes" },
  TodoWrite: { title: "Keep a to-do list", about: "Writes down the steps of a long job and ticks them off.", access: "read", set: "notes" },
};
const SETS: { id: string; title: string; about: string }[] = [
  { id: "files", title: "Files & Search", about: "read, write, edit, find" },
  { id: "terminal", title: "Terminal & Processes", about: "terminal, process" },
  { id: "web", title: "Web & Browser", about: "web, browser" },
  { id: "helpers", title: "Skills & Helpers", about: "skill, agent" },
  { id: "notes", title: "Memory & Planning", about: "remember, to-do" },
];

export const toolId = (name: string): string => `tool:${name}`;

/** How many times each tool was used on this computer, kept in its own state. */
export class ToolUsage {
  #counts: Record<string, number> | undefined;
  constructor(private readonly file: string) {}
  counts(): Record<string, number> {
    if (this.#counts) return this.#counts;
    try { const raw = JSON.parse(readFileSync(this.file, "utf8")) as { counts?: Record<string, unknown> }; this.#counts = Object.fromEntries(Object.entries(raw.counts ?? {}).filter((e): e is [string, number] => typeof e[1] === "number")); } catch { this.#counts = {}; }
    return this.#counts;
  }
  add(name: string): void {
    const counts = this.counts();
    counts[name] = (counts[name] ?? 0) + 1;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: 1, counts }));
      renameSync(tmp, this.file);
    } catch { /* a count is a convenience: a full disk must not stop the work */ }
  }
}

/** Every tool of the agent as a list shows it. A tool with no words of its own is still listed, under its own name. */
export function listTools(state: PluginState, usage: ToolUsage, tools: readonly Tool[] = defaultTools()): ToolInfo[] {
  const counts = usage.counts(), toolOn = toolSwitch(state);
  return tools.map((t): ToolInfo => {
    const w = WORDS[t.name];
    return { name: t.name, title: w?.title ?? t.name, about: w?.about ?? t.description.split(/(?<=\.)\s/)[0]!.slice(0, 160), access: w?.access ?? (t.readOnly ? "read" : "change"), enabled: toolOn(t.name), core: w?.core === true, small: w?.small === true, calls: counts[t.name] ?? 0, set: w?.set ?? "helpers" };
  });
}

/** The tools gathered into the sets a page shows as cards. A set is on when any of its tools is on. */
export function listSets(items: readonly ToolInfo[]): ToolSetInfo[] {
  return SETS.map((s) => {
    const own = items.filter((t) => t.set === s.id);
    return { ...s, tools: own.map((t) => t.name), enabled: own.some((t) => t.enabled), calls: own.reduce((n, t) => n + t.calls, 0) };
  }).filter((s) => s.tools.length > 0);
}

/** The tools to give a new conversation: everything except what the person switched off. */
export function activeTools(state: PluginState, tools: readonly Tool[] = defaultTools()): Tool[] {
  const on = toolSwitch(state);
  return tools.filter((t) => on(t.name));
}

/** What is true of a tool that only this computer can say: it waits for something the person must connect, or exists but cannot run in this place. */
export type Availability = (row: ToolRow) => "needs-setup" | "unavailable-here" | undefined;

/** Whether a row is switched on: its own switch, or (from before the rows) the switches of all its tools. An experimental row is on only when the person said so. */
function rowOn(off: ReadonlySet<string>, on: ReadonlySet<string>, row: ToolRow): boolean {
  if (off.has(toolId(row.id))) return false;
  if (row.names.length && row.names.every((n) => off.has(toolId(n)))) return false;
  return row.experimental ? on.has(toolId(row.id)) : true;
}

/** Every tool with its own switch, by category, and what state it is in. A row whose tools the engine does not have is listed as unavailable. */
export function listEntries(state: PluginState, usage: ToolUsage, tools: readonly Tool[] = defaultTools(), availability: Availability = () => undefined, setups: ReadonlySet<string> = new Set()): ToolEntry[] {
  const off = state.disabled(), counts = usage.counts(), on = state.enabledExplicitly();
  const have = new Set(tools.map((t) => t.name));
  const order = (id: string): number => CATEGORIES.findIndex((c) => c.id === id);
  return [...TOOL_ROWS].sort((a, b) => order(a.category) - order(b.category)).map((row): ToolEntry => {
    const own = row.names.filter((n) => have.has(n));
    const switched = rowOn(off, on, row);
    const asked = availability(row);
    // What a tool is decides its state: one that does not exist yet is soon, one that is experimental is experimental on every computer (the switch says whether it is used), and only the rest depend on this computer.
    const status: ToolState = row.names.length === 0 ? "soon" : row.experimental ? "experimental" : own.length === 0 || asked === "unavailable-here" ? "unavailable-here" : !switched ? "off" : asked === "needs-setup" ? "needs-setup" : "on";
    return { id: row.id, category: row.category, names: [...row.names], title: row.title, about: row.about, on: switched, state: status, ...(setups.has(row.id) ? { setup: true as const } : {}), calls: row.names.reduce((n, name) => n + (counts[name] ?? 0), 0) };
  });
}

/** The row a name stands for: a row id, or the name of one of its tools. */
export const resolveRow = (name: string): ToolRow | undefined => TOOL_ROWS.find((r) => r.id === name) ?? rowOf(name);

/** Switches one row, and takes back what the switches of its single tools said before there were rows. */
export function switchRow(state: PluginState, row: ToolRow, enabled: boolean): void {
  for (const n of row.names) state.forget(toolId(n));
  state.set(toolId(row.id), enabled);
}

/** The test the engine asks before it offers or runs a tool: a tool with no row of its own (a connected program's) is always allowed. */
export function toolSwitch(state: PluginState): (name: string) => boolean {
  return (name) => {
    const off = state.disabled(), row = rowOf(name);
    // What was said about this one tool before there were rows still holds for it.
    if (off.has(toolId(name))) return false;
    return row ? rowOn(off, state.enabledExplicitly(), row) : true;
  };
}
