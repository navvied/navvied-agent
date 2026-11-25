import { afterAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Jobs } from "../src/jobs.ts";
import { sweep, track } from "../src/orphans.ts";
import { processStart } from "../src/platform.ts";
import { until } from "./helpers.ts";

const dir = mkdtempSync(join(tmpdir(), "navvied-orphans-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const records = (): string[] => readdirSync(dir).filter((f) => f.startsWith("orphan-"));
const linux = process.platform === "linux";

/** A command in a process group of its own, as every command of the Bash tool is. */
const command = () => spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
const gone = (pid: number): boolean => { try { process.kill(pid, 0); return false; } catch { return true; } };

describe.skipIf(!linux)("a confined command whose program was killed is ended by the next start", () => {
  test("the record exists while the command runs and is gone when it has ended", () => {
    const child = command();
    try {
      const forget = track(dir, child.pid);
      expect(records()).toEqual([`orphan-${process.pid}-${child.pid}.json`]);
      forget();
      expect(records()).toEqual([]);
    } finally { child.kill(); }
  });

  test("a command whose program is gone is ended, with its record; one whose program still runs is left alone", async () => {
    const mine = command(), other = command();
    try {
      track(dir, mine.pid);
      // The program that wrote the record has another start time now: it is gone, and its number belongs to another program.
      const startOf = (pid: number): string | undefined => (pid === process.pid ? "another start" : processStart(pid));
      expect(sweep(dir)).toEqual([]);
      expect(gone(mine.pid!)).toBe(false);
      expect(sweep(dir, startOf)).toEqual([mine.pid!]);
      await until(() => gone(mine.pid!) || mine.exitCode !== null || mine.signalCode !== null);
      expect(records()).toEqual([]);
      expect(gone(other.pid!)).toBe(false);
    } finally { mine.kill(); other.kill(); }
  });

  test("a number that now belongs to another program is never touched: the start time must match as well", () => {
    const child = command();
    try {
      track(dir, child.pid);
      const startOf = (pid: number): string | undefined => (pid === process.pid ? "another start" : "not the recorded start");
      expect(sweep(dir, startOf)).toEqual([]);
      expect(gone(child.pid!)).toBe(false);
      expect(records()).toEqual([]);
    } finally { child.kill(); }
  });

  test("starting a conversation's jobs sweeps what an earlier, killed run left", async () => {
    const child = command();
    try {
      const startOf = (owner: string) => (pid: number): string | undefined => (pid === process.pid ? owner : processStart(pid));
      new Jobs(() => {}, Date.now, { dir, session: "s", startOf: startOf("first run") }).track(child.pid);
      new Jobs(() => {}, Date.now, { dir, session: "s", startOf: startOf("second run") }).recover();
      await until(() => child.exitCode !== null || child.signalCode !== null);
      expect(records()).toEqual([]);
    } finally { child.kill(); }
  });
});
