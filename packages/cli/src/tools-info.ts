import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { defaultTools, type Tool } from "@navvied/engine";
import type { ToolInfo, ToolSetInfo } from "@navvied/protocol";
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
  const off = state.disabled(), counts = usage.counts();
  return tools.map((t): ToolInfo => {
    const w = WORDS[t.name];
    return { name: t.name, title: w?.title ?? t.name, about: w?.about ?? t.description.split(/(?<=\.)\s/)[0]!.slice(0, 160), access: w?.access ?? (t.readOnly ? "read" : "change"), enabled: !off.has(toolId(t.name)), core: w?.core === true, small: w?.small === true, calls: counts[t.name] ?? 0, set: w?.set ?? "helpers" };
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
  const off = state.disabled();
  return tools.filter((t) => !off.has(toolId(t.name)));
}
