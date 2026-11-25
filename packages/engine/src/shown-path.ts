import { homedir } from "node:os";
import { isAbsolute, relative } from "node:path";

const slashed = (p: string): string => p.replace(/\\/g, "/");

/** A file as a person should read it: from the project folder when it is inside, `~/` from the home folder when it is there, otherwise the full path. */
export function shownPath(file: string, cwd: string, home: string = process.env.HOME || homedir()): string {
  for (const [base, prefix] of [[cwd, ""], [home, "~/"]] as const) {
    const inside = relative(base, file);
    if (inside && inside !== ".." && !inside.startsWith("../") && !inside.startsWith("..\\") && !isAbsolute(inside)) return `${prefix}${slashed(inside)}`;
  }
  return slashed(file);
}
