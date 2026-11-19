import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

export const INSTRUCTION_FILE = "NAVVIED.md";
/** In each folder only the first of these that exists is read, so a project that keeps two names for the same text is not read twice. */
export const INSTRUCTION_FILES: readonly string[] = [INSTRUCTION_FILE];
const MAX_FILE = 20_000;
const MAX_TOTAL = 60_000;

const readFile = (path: string): string | undefined => {
  try {
    if (!existsSync(path) || !statSync(path).isFile()) return undefined;
    const text = readFileSync(path, "utf8").trim();
    return text ? text.slice(0, MAX_FILE) : undefined;
  } catch { return undefined; }
};

/** The folders from the top of the project (or the root of the disk) down to `cwd`. */
export const projectDirs = (cwd: string): string[] => {
  const dirs: string[] = [];
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    dirs.unshift(dir);
    if (existsSync(join(dir, ".git")) || dirname(dir) === dir) break;
  }
  return dirs;
};

/** The first file of `names` in `dir` that has text. */
const firstIn = (dir: string, names: readonly string[]): { name: string; text: string } | undefined => {
  for (const name of names) { const text = readFile(join(dir, name)); if (text) return { name, text }; }
  return undefined;
};

const shown = (cwd: string, dir: string, name: string): string => relative(resolve(cwd), join(dir, name)).replace(/\\/g, "/") || name;

/** The instruction files in effect for `cwd`, in the order they are read (paths relative to `cwd`, or `~` for the user's own). */
export function instructionFiles(cwd: string, userDir?: string, names: readonly string[] = INSTRUCTION_FILES): string[] {
  const user = userDir && readFile(join(userDir, INSTRUCTION_FILE)) ? ["~/" + INSTRUCTION_FILE] : [];
  return [...user, ...projectDirs(cwd).flatMap((d) => { const found = firstIn(d, names); return found ? [shown(cwd, d, found.name)] : []; })];
}

/**
 * Standing instructions for the agent: the user's own file, then the first of `names` (`NAVVIED.md` unless the caller lists more) in every folder from the project root down to
 * `cwd` (the project root is the nearest directory with `.git`; without one, the filesystem root). Inner files come last,
 * so they win. Read on every call, so edits apply to the next turn.
 */
export function loadInstructions(cwd: string, userDir?: string, memory?: string, names: readonly string[] = INSTRUCTION_FILES): string | undefined {
  const parts: string[] = [];
  const user = userDir ? readFile(join(userDir, INSTRUCTION_FILE)) : undefined;
  if (user) parts.push(`# Your personal instructions\n${user}`);
  for (const dir of projectDirs(cwd)) {
    const found = firstIn(dir, names);
    if (found) parts.push(`# Instructions from ${shown(cwd, dir, found.name)}\n${found.text}`);
  }
  if (memory) parts.push(memory);
  if (!parts.length) return undefined;
  const all = parts.join("\n\n");
  return all.length > MAX_TOTAL ? `${all.slice(0, MAX_TOTAL)}\n… [instructions truncated]` : all;
}
