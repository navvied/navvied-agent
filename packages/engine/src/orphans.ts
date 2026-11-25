import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { processStart } from "./platform.ts";

/**
 * Second line behind the sandbox's own guard (`sandbox/bubblewrap.ts`): a command that must end with this program is written down with the start time
 * of both (a number alone may be another program's), and the next start ends what is left of a program that is gone. Only a process whose number AND
 * start time are the recorded ones is touched, so nobody else's program can be.
 */
interface Entry { pid: number; start: string; owner: number; ownerStart: string }

const name = (owner: number, pid: number): string => `orphan-${owner}-${pid}.json`;
const same = (pid: number, start: string, startOf: (pid: number) => string | undefined): boolean => startOf(pid) === start;

let own: string | undefined;
/** This program's own start time never changes: it is read once. */
const ownStart = (startOf: (pid: number) => string | undefined): string | undefined => startOf === processStart ? (own ??= startOf(process.pid)) : startOf(process.pid);

/** Writes the record of `pid` (leader of its own process group) and returns the call that removes it when the command has ended. */
export function track(dir: string, pid: number | undefined, startOf: (pid: number) => string | undefined = processStart): () => void {
  const start = pid === undefined ? undefined : startOf(pid), ownerStart = ownStart(startOf);
  if (pid === undefined || start === undefined || ownerStart === undefined) return () => {};
  const file = join(dir, name(process.pid, pid));
  try { writeFileSync(file, JSON.stringify({ pid, start, owner: process.pid, ownerStart } satisfies Entry), { mode: 0o600 }); } catch { return () => {}; }
  return () => rmSync(file, { force: true });
}

/** Ends the commands of programs that no longer run, and forgets their records. Returns the process numbers it ended. */
export function sweep(dir: string, startOf: (pid: number) => string | undefined = processStart): number[] {
  const ended: number[] = [];
  let files: string[];
  try { files = readdirSync(dir).filter((f) => f.startsWith("orphan-") && f.endsWith(".json")); } catch { return ended; }
  for (const f of files) {
    const file = join(dir, f);
    let r: Entry;
    try { r = JSON.parse(readFileSync(file, "utf8")) as Entry; } catch { rmSync(file, { force: true }); continue; }
    if (same(r.owner, r.ownerStart, startOf)) continue;
    if (same(r.pid, r.start, startOf)) { try { process.kill(-r.pid, "SIGKILL"); ended.push(r.pid); } catch { /* gone in between */ } }
    rmSync(file, { force: true });
  }
  return ended;
}
