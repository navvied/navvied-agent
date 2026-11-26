import { closeSync, mkdirSync, openSync, rmSync, statSync, writeSync } from "node:fs";
import { dirname } from "node:path";

const A_DEAD_HOLDER_MS = 10_000;
const GIVE_UP_MS = 5_000;
const STEP_MS = 15;

const pause = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

export interface LockSystem { open: typeof openSync; platform: NodeJS.Platform; now(): number }

const THIS_COMPUTER: LockSystem = { open: openSync, platform: process.platform, now: Date.now };

export function withFileLock<T>(path: string, fn: () => T, given: Partial<LockSystem> = {}): T {
  const system = { ...THIS_COMPUTER, ...given };
  const lock = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true });
  const begun = system.now();
  for (;;) {
    try { const fd = system.open(lock, "wx", 0o600); writeSync(fd, String(process.pid)); closeSync(fd); break; } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      const beingRemoved = system.platform === "win32" && code === "EPERM";
      if (code !== "EEXIST" && !beingRemoved) throw e;
      const waitedTooLong = system.now() - begun > GIVE_UP_MS;
      if (beingRemoved) {
        if (waitedTooLong) throw e;
        pause(STEP_MS);
        continue;
      }
      let age = 0;
      try { age = system.now() - statSync(lock).mtimeMs; } catch { continue; }
      if (age > A_DEAD_HOLDER_MS || waitedTooLong) { rmSync(lock, { force: true }); continue; }
      pause(STEP_MS);
    }
  }
  try { return fn(); } finally { rmSync(lock, { force: true }); }
}
