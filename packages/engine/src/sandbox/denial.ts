import { resolve } from "node:path";
import { allowsWrite, isHidden, type Plan } from "./policy.ts";

/** What the sandbox stopped: a write outside the folders that may be written, or a look at something it hides. */
export interface Denial { path: string; kind: "write" | "hidden" }

const READ_ONLY = /read-only file system|\bEROFS\b/i;
const REFUSED = /permission denied|\bEACCES\b|operation not permitted|\bEPERM\b/i;
const QUOTED = /['"`‘](\/[^'"`’\n]+)['"`’]/g;
const BARE = /(?:^|[\s(=])(\/[^\s'"`:,;()<>]+)/g;

function pathsIn(line: string): string[] {
  const quoted = [...line.matchAll(QUOTED)].map((m) => m[1]!);
  return quoted.length ? quoted : [...line.matchAll(BARE)].map((m) => m[1]!);
}

/**
 * Whether a command that failed was stopped by the sandbox, and what it was stopped at. Only what the sandbox itself makes is looked for:
 * "read-only file system" for a path it does not let be written, and a refusal for a path it hides. A refusal anywhere else is an
 * ordinary one (the command would meet it outside too), and a path inside the allowed folders is not a denial at all.
 */
export function denialIn(output: string, plan: Plan, cwd: string): Denial | undefined {
  for (const line of output.split("\n")) {
    const readOnly = READ_ONLY.test(line);
    if (!readOnly && !REFUSED.test(line)) continue;
    for (const raw of pathsIn(line)) {
      const path = resolve(cwd, raw);
      if (isHidden(plan, path)) return { path, kind: "hidden" };
      if (readOnly && !allowsWrite(plan, path)) return { path, kind: "write" };
    }
  }
  return undefined;
}
