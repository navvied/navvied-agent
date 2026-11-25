import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { programName, shellView } from "../shell-scan.ts";

/** Flags of each program that only change how the file is shown, and the ones that take a value. */
const FLAGS: Record<string, { plain: RegExp; value: RegExp }> = {
  cat: { plain: /^-[nbsEATv]+$/, value: /^$/ },
  head: { plain: /^(-q|-\d+|-n[+-]?\d+|-c\d+)$/, value: /^-[nc]$/ },
  tail: { plain: /^(-q|-\d+|-n[+-]?\d+|-c\d+)$/, value: /^-[nc]$/ },
};
const SED_RANGE = /^(\d+(,(\d+|\$))?|\$)p$/;
const NUMBER = /^[+-]?\d+$/;

/**
 * The files a command line only reads and prints, when that is all it does: one `cat`, `head`, `tail` or `sed -n 'N,Mp'`, no redirect, no pipe, no other command,
 * nothing whose words are built while it runs. Anything else gives no files, so that a command that could change a file never counts as a read of it.
 */
export function printedFiles(command: string, cwd: string): string[] {
  const view = shellView(command);
  const [cmd, ...rest] = view.cmds;
  if (!cmd || rest.length || view.found.length || cmd.sudo || cmd.fed || cmd.redirects.length || cmd.stdin !== undefined || cmd.dyn.some(Boolean)) return [];
  const name = programName(cmd.words[0]!), args = cmd.words.slice(1);
  const files: string[] = [];
  let sed = name === "sed" ? "n" : "";
  for (let i = 0; i < args.length; i++) {
    const w = args[i]!;
    if (name === "sed") {
      if (sed === "n" && w === "-n") { sed = "script"; continue; }
      if (sed === "script") { if (!SED_RANGE.test(w)) return []; sed = "files"; continue; }
      if (sed !== "files" || w.startsWith("-") && w !== "-") return [];
    } else {
      const f = FLAGS[name];
      if (!f) return [];
      if (w.startsWith("-") && w !== "-") {
        if (f.value.test(w)) { if (!NUMBER.test(args[++i] ?? "")) return []; continue; }
        if (!f.plain.test(w)) return [];
        continue;
      }
    }
    if (w === "-") return [];
    files.push(isAbsolute(w) ? w : resolve(cwd, w));
  }
  if (sed !== "files" && name === "sed") return [];
  return files.filter((f) => { try { return statSync(f).isFile(); } catch { return false; } }).length === files.length ? files : [];
}
