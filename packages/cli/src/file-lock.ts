import { closeSync, mkdirSync, openSync, rmSync, statSync, writeSync } from "node:fs";
import { dirname } from "node:path";

const STALE_MS = 10_000;
const GIVE_UP_MS = 5_000;
const STEP_MS = 15;

const pause = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

/**
 * Runs `fn` while holding the lock file `<path>.lock`, so two programs changing one file (the hub's timer and a tool in another
 * process) take turns instead of overwriting each other. A lock older than 10 seconds belongs to a program that died and is taken over;
 * after 5 seconds of waiting the lock is taken over as well, so a stuck holder can never stop the work.
 */
export function withFileLock<T>(path: string, fn: () => T, now: () => number = Date.now): T {
  const lock = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true });
  const begun = now();
  for (;;) {
    try { const fd = openSync(lock, "wx", 0o600); writeSync(fd, String(process.pid)); closeSync(fd); break; } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      let age = 0;
      try { age = now() - statSync(lock).mtimeMs; } catch { continue; }
      if (age > STALE_MS || now() - begun > GIVE_UP_MS) { rmSync(lock, { force: true }); continue; }
      pause(STEP_MS);
    }
  }
  try { return fn(); } finally { rmSync(lock, { force: true }); }
}
