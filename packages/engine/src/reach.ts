import { nativePaths, type Paths } from "./rules.ts";
import { programName, shellView } from "./shell-scan.ts";
import { changedPaths, readPaths } from "./tools/changed.ts";
import { outsideProject } from "./where.ts";

/** What a call reaches outside the project: files it changes, files it opens, and places it searches through. */
export interface Reach { writes: string[]; opens: string[]; searches: string[] }

/** The searching tools: they walk a whole place, so a place outside the project is far more than one file read. */
const SEARCHERS: ReadonlySet<string> = new Set(["Glob", "Grep"]);

const GREP = /^(grep|egrep|fgrep)$/;
const WALKERS = /^(rg|ag|ack)$/;
/** Options of grep, rg and ag that give the pattern themselves, so every word left is a place. */
const PATTERN_GIVEN = /^(-e|-f|--regexp|--file|--files|-g|--glob)$|^--(regexp|file)=/;

/** The places a shell command searches through (find, recursive grep, rg, ag, ack, fd): what each is told to walk, which is the working folder when it names none. */
export function searchRoots(command: string): string[] {
  const roots: string[] = [];
  for (const c of shellView(command).cmds) {
    const head = programName(c.words[0] ?? "");
    const args = c.words.slice(1);
    const plain = args.filter((a) => !a.startsWith("-"));
    if (head === "find") {
      const end = args.findIndex((a) => a.startsWith("-") || a === "!" || a === "(");
      roots.push(...args.slice(0, end < 0 ? args.length : end));
    } else if (WALKERS.test(head) || (GREP.test(head) && args.some((a) => /^-[a-zA-Z]*[rR]/.test(a) || a === "--recursive" || a === "--dereference-recursive"))) {
      roots.push(...(args.some((a) => PATTERN_GIVEN.test(a)) ? plain : plain.slice(1)));
    } else if (head === "fd" || head === "fdfind") {
      roots.push(...plain.slice(1));
    }
  }
  return roots;
}

/** Everything a call of a tool reaches outside the project (and outside scratch space): the one question the modes answer for writes, opens and searches alike. */
export function reachOutside(tool: string, args: Record<string, unknown>, cwd: string, p: Paths = nativePaths, kept: readonly string[] = []): Reach {
  const away = (list: string[], extra: readonly string[] = []): string[] => list.filter((f) => outsideProject(f, cwd, p, extra));
  const looked = readPaths(tool, args);
  return {
    writes: away(changedPaths(tool, args)),
    opens: SEARCHERS.has(tool) ? [] : away(looked, kept),
    searches: away(SEARCHERS.has(tool) ? looked : tool === "Bash" && typeof args.command === "string" ? searchRoots(args.command) : [], kept),
  };
}
