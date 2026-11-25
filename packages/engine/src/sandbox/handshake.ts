import { createReadStream, createWriteStream } from "node:fs";
import type { ChildProcess } from "node:child_process";
import type { Readable, Writable } from "node:stream";

/** The two extra descriptors of a guarded command, after the three standard ones and the one the filter uses: 4 is where the guard says it runs, 5 is where it waits for the answer. */
export const GUARD_STDIO = ["ignore", "pipe", "pipe"] as const;

/** `base` (the three standard descriptors) with the guard's added when the command is guarded; typed as `base` so the child's streams stay typed. */
export const withGuardStdio = <T extends ["ignore" | "pipe", "pipe", "pipe"]>(base: T, guarded: boolean): T => (guarded ? [...base, ...GUARD_STDIO] as unknown as T : base);

/**
 * The engine's half of the handshake (the guard is `GUARD` in `bubblewrap.ts`): when the guard says it runs, so bubblewrap's death signal is armed,
 * the command is let go. A program that dies before answering closes the guard's input, and the guard ends without starting the command.
 */
export function release(ready: Readable, go: Writable): void {
  let sent = false;
  const finish = (): void => { ready.destroy(); go.destroy(); };
  go.on("error", () => {});
  ready.on("error", () => {});
  ready.once("data", () => { sent = true; go.end("go\n", finish); });
  ready.once("close", () => { if (!sent) finish(); });
}

/** `release` for a child started with `withGuardStdio`. */
export const releaseChild = (child: ChildProcess): void => { const [ready, go] = (child.stdio as unknown as (Readable & Writable)[]).slice(4); release(ready!, go!); };

/** The same for a child whose extra descriptors are numbers (Bun's own terminal start). */
export const releaseFds = (fds: [number, number]): void => release(createReadStream("", { fd: fds[0] }), createWriteStream("", { fd: fds[1] }));
