import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launch } from "../src/tools/browser/launch.ts";

const dir = mkdtempSync(join(tmpdir(), "navvied-browser-end-"));
const started: number[] = [];
afterAll(() => { for (const pid of started) if (runs(pid)) process.kill(pid, "SIGKILL"); rmSync(dir, { recursive: true, force: true }); });

/** Running: there, and not a zombie that only waits for its parent. */
const runs = (pid: number): boolean => {
  try { const stat = readFileSync(`/proc/${pid}/stat`, "utf8"); return !"ZXx".includes(stat[stat.lastIndexOf(")") + 2]!); } catch { return false; }
};

/**
 * A stand-in for a browser, as Chrome behaves: it starts one helper in its own group and one that leaves the group (a session of its own,
 * in another folder, with no word of the profile in its command line), as Chrome's crash reporter does, and then says where it listens.
 */
function standIn(name: string): { program: string; pids: () => { own: number; left: number } } {
  const program = join(dir, name), told = join(dir, `${name}.json`);
  writeFileSync(program, `#!${process.execPath}
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const sleeper = (detached) => spawn("sleep", ["60"], { cwd: "/", detached, stdio: "ignore" }).pid;
writeFileSync(${JSON.stringify(told)}, JSON.stringify({ own: sleeper(false), left: sleeper(true) }));
const profile = process.argv.find((a) => a.startsWith("--user-data-dir=")).slice("--user-data-dir=".length);
writeFileSync(profile + "/DevToolsActivePort", "1\\n/devtools/browser/x\\n");
setInterval(() => {}, 1000);
`);
  chmodSync(program, 0o755);
  return { program, pids: () => { const p = JSON.parse(readFileSync(told, "utf8")) as { own: number; left: number }; started.push(p.own, p.left); return p; } };
}

describe.skipIf(process.platform !== "linux")("a browser that is stopped", () => {
  test("has ended when stop returns, also the helper that left its group; another browser's processes are left alone", async () => {
    const mine = standIn("mine"), other = standIn("other");
    const [a, b] = [await launch(mine.program, 1), await launch(other.program, 1)];
    const [pa, pb] = [mine.pids(), other.pids()];
    try {
      expect([pa.own, pa.left, pb.own, pb.left].map(runs)).toEqual([true, true, true, true]);
      a.stop();
      // Not waited for here: a program that exits right after stop() leaves whatever still runs.
      expect([pa.own, pa.left].map(runs)).toEqual([false, false]);
      expect([pb.own, pb.left].map(runs)).toEqual([true, true]);
    } finally { a.stop(); b.stop(); }
    expect([pb.own, pb.left].map(runs)).toEqual([false, false]);
  }, 30_000);
});
