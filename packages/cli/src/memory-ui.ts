import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { INSTRUCTION_FILE, MEMORY_FILE, PROJECT_MEMORY, type MemoryPaths } from "@navvied/engine";
import type { Choice } from "./io.ts";

/** Where notes are kept: for every project next to the configuration file, for this project in its `.navvied` folder. */
export const memoryPathsFor = (cwd: string, configFile: string): MemoryPaths => ({ user: join(dirname(configFile), MEMORY_FILE), project: join(cwd, PROJECT_MEMORY) });

export type MemoryAction = { kind: "open"; file: string; header: string } | { kind: "add" };
export interface MemoryRow extends Choice { action: MemoryAction }

const lines = (file: string): number => { try { return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter((l) => l.startsWith("- ")).length : 0; } catch { return 0; } };

/** What a person can do with what navvied remembers, in the order of the approved screen. */
export function memoryRows(paths: MemoryPaths, cwd: string): MemoryRow[] {
  const project = lines(paths.project), mine = paths.user ? lines(paths.user) : 0;
  const instructions = join(cwd, INSTRUCTION_FILE);
  return [
    { label: "This project's notes", hint: `${project ? `${project} note${project === 1 ? "" : "s"} the agent kept` : "Nothing kept yet"}. Opens the file.`, action: { kind: "open", file: paths.project, header: "# What navvied remembers\n\n" } },
    { label: "Instructions for this project", hint: `${existsSync(instructions) ? INSTRUCTION_FILE : `${INSTRUCTION_FILE} does not exist yet`}. Rules it follows every time. Opens the file.`, action: { kind: "open", file: instructions, header: "# Instructions for navvied\n\n" } },
    { label: "Add a note", hint: "Something to remember from now on, in this project.", action: { kind: "add" } },
    ...(paths.user ? [{ label: "Notes for all my projects", hint: `${mine ? `${mine} note${mine === 1 ? "" : "s"}` : "Nothing kept yet"}. Your own habits, kept on this computer. Opens the file.`, action: { kind: "open" as const, file: paths.user, header: "# What navvied remembers\n\n" } }] : []),
  ];
}

/** Makes sure a file exists before it is opened, so the editor does not meet a missing one. */
export function ensureFile(file: string, header: string): void {
  if (existsSync(file)) return;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, header);
}
