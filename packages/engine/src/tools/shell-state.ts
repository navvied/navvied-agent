import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

/** What a conversation's commands remember between calls: the folder, and the variables a command exported. */
export interface ShellState {
  /** The folder the next command starts in, always inside the working folder. */
  dir?: string;
  /** Where the exports are kept (a private folder of its own). */
  folder?: string;
}

const slashed = (p: string): string => p.replaceAll("\\", "/");
const quoted = (p: string): string => `'${slashed(p).replaceAll("'", `'\\''`)}'`;

/** The folder the state is kept in, made when first needed and mode 0700, since an export may be a secret the person set. */
function folderOf(state: ShellState): string {
  state.folder ??= mkdtempSync(join(tmpdir(), "navvied-shell-"));
  return state.folder;
}

/**
 * The command, written so that it starts from what earlier commands exported and, when it ends however it ends, writes down where it
 * ended and which variables it set or changed (only those: the rest of the environment, which may hold keys, is never written).
 * Bash only.
 */
export function remembering(command: string, state: ShellState, capture = true): string {
  const folder = folderOf(state);
  const exports = quoted(join(folder, "exports"));
  const where = quoted(join(folder, "where"));
  const base = [`__nv_base=$(export -p | sort)`, `[ -s ${exports} ] && . ${exports} 2>/dev/null`].join("\n");
  // Defined as a function, run when the shell ends however it ends (also on `exit 3`): the status the command ended with is kept.
  const keep = capture
    ? [
      `__nv_save() {`,
      `  printf %s "$(pwd -W 2>/dev/null || pwd)" > ${where}`,
      `  comm -13 <(printf %s "$__nv_base") <(export -p | sort) | grep -v -E '^declare -x (_|SHLVL|PWD|OLDPWD|BASH[A-Za-z_]*)=' > ${exports}.new`,
      `  mv -f ${exports}.new ${exports}`,
      `}`,
      `trap __nv_save EXIT`,
    ].join("\n")
    : "";
  return `${base}\n${keep}\n${command}\n`;
}

/** Where the last command ended, if it said. */
export function endedIn(state: ShellState): string | undefined {
  if (!state.folder) return undefined;
  const file = join(state.folder, "where");
  try { const text = readFileSync(file, "utf8").trim(); rmSync(file, { force: true }); return text || undefined; } catch { return undefined; }
}

/** Whether `dir` is `root` or inside it. */
export const inside = (root: string, dir: string): boolean => { const rel = relative(resolve(root), resolve(dir)); return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)); };

export function forget(state: ShellState): void {
  if (state.folder && existsSync(state.folder)) rmSync(state.folder, { recursive: true, force: true });
  state.folder = undefined;
  state.dir = undefined;
}
