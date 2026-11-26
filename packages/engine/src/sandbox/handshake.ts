import { closeSync, writeSync } from "node:fs";
import type { ChildProcess } from "node:child_process";
import type { Readable, Writable } from "node:stream";

export const GUARD_STDIO = ["ignore", "pipe", "pipe"] as const;

export const withGuardStdio = <T extends ["ignore" | "pipe", "pipe", "pipe"]>(base: T, guarded: boolean): T => (guarded ? [...base, ...GUARD_STDIO] as unknown as T : base);

export function release(ready: Readable, go: Writable): void {
  let sent = false;
  const finish = (): void => { ready.destroy(); go.destroy(); };
  go.on("error", () => {});
  ready.on("error", () => {});
  ready.once("data", () => { sent = true; go.end("go\n", finish); });
  ready.once("close", () => { if (!sent) finish(); });
}

export const releaseChild = (child: ChildProcess): void => { const [ready, go] = (child.stdio as unknown as (Readable & Writable)[]).slice(4); release(ready!, go!); };

async function answerGuard(ready: number, go: number): Promise<void> {
  const reader = Bun.file(ready).stream().getReader();
  try {
    if (!(await reader.read()).done) writeSync(go, "go\n");
  } finally {
    await reader.cancel();
  }
}

const closeOwned = (fd: number): void => { try { closeSync(fd); } catch { return; } };

export function releaseFds([ready, go]: [number, number]): void {
  void answerGuard(ready, go)
    .catch(() => undefined)
    .finally(() => { closeOwned(ready); closeOwned(go); });
}
