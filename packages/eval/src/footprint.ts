import { mkdtempSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface Footprint {
  /** Bytes on disk of what is installed (a file, or a folder with everything in it). */
  installBytes: number | undefined;
  /** The first start, with a home folder that has never been used. */
  firstMs: number;
  /** The middle one of the starts after that, each with a new home folder too. */
  medianMs: number;
  runs: number;
}

/** The size of a file, or of a folder and everything in it. */
export function sizeOf(path: string): number {
  const real = realpathSync(path);
  const st = statSync(real);
  if (!st.isDirectory()) return st.size;
  return readdirSync(real).reduce((n, name) => n + sizeOf(join(real, name)), 0);
}

const median = (xs: number[]): number => { const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2; };

/**
 * What it costs to have the program: its size on disk, and how long it takes to start. The start is `command` (normally `--version`)
 * run `runs` times, each with a home folder that has never been used. The first is told apart from the rest: it is the nearest to
 * a cold start that can be made without dropping the system's file cache, which needs more rights than this has.
 */
export async function footprint(command: string[], options: { install?: string; runs?: number } = {}): Promise<Footprint> {
  const runs = Math.max(2, options.runs ?? 5);
  // Without a path, the program is found by its name; the runtime that runs the source is not the program, so it is not measured.
  const name = command[0] ?? "";
  const where = options.install ?? (/(^|[\\/])(bun|node)(\.exe)?$/.test(name) ? undefined : Bun.which(name));
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const home = mkdtempSync(join(tmpdir(), "navvied-footprint-"));
    const started = performance.now();
    const p = Bun.spawn(command, { env: { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home, XDG_STATE_HOME: home, APPDATA: home }, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    await p.exited;
    times.push(performance.now() - started);
    rmSync(home, { recursive: true, force: true });
  }
  return { installBytes: where ? sizeOf(where) : undefined, firstMs: Math.round(times[0]!), medianMs: Math.round(median(times.slice(1))), runs };
}
