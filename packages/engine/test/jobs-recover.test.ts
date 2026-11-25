import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineEvent } from "@navvied/protocol";
import { Jobs, stopAllJobs } from "../src/index.ts";
import { processStart } from "../src/platform.ts";
import { HOOK_MS, hook, removeTree } from "../../protocol/test/support/cleanup.ts";
import { until } from "./helpers.ts";

const dir = mkdtempSync(join(tmpdir(), "navvied-recover-"));
afterAll(hook("recover removes what it made", async () => { await stopAllJobs(); await removeTree(dir); }), HOOK_MS);

const node = (code: string): string[] => [process.execPath, "-e", code];
const posix = process.platform !== "win32";
let n = 0;
/** A conversation's state folder, and a way to start "the program" again on it: a second Jobs of the same conversation, while the first is simply never closed. */
const world = () => {
  const state = join(dir, `state${n++}`);
  mkdirSync(state, { recursive: true });
  const events: EngineEvent[] = [];
  const again = (session = "s1", startOf?: (pid: number) => string | undefined) => new Jobs((e) => events.push(e), Date.now, { dir: state, session, ...(startOf ? { startOf } : {}) });
  return { state, events, again };
};
const records = (state: string): string[] => readdirSync(state).filter((f) => f.endsWith(".json"));

describe.skipIf(!posix)("a command that still runs after the program restarted is taken back", () => {
  test("its output tail and its stop still work, its input does not, and nothing is started again", async () => {
    const w = world();
    const before = w.again();
    const marker = join(w.state, "starts.txt");
    const job = before.start(node(`require('fs').appendFileSync(${JSON.stringify(marker)}, 'start\\n'); console.log('hello from before'); setInterval(() => {}, 1000)`), dir, "dev server");
    await until(() => before.read(job.id, true)?.output.includes("hello") ?? false);
    expect(records(w.state)).toEqual(["s1-job1.json"]);
    const pid = (JSON.parse(readFileSync(join(w.state, "s1-job1.json"), "utf8")) as { pid: number }).pid;

    // The program died without stopping it (a crash, a kill): a new one starts with the same conversation.
    const after = w.again();
    after.recover();
    const back = after.list();
    expect(back).toMatchObject([{ id: "job1", title: "dev server", status: "running" }]);
    expect(after.read("job1")!.output).toContain("hello from before");
    expect(after.type("job1", "x\n")).toBe(false);
    expect(after.endInput("job1")).toBe(false);
    expect(readFileSync(marker, "utf8")).toBe("start\n");
    // A new job gets a new number.
    expect(after.start(node("0"), dir, "next").id).toBe("job2");

    after.stop("job1");
    await until(() => after.list().find((j) => j.id === "job1")?.status === "stopped" && !alive(pid));
    await until(() => after.list().find((j) => j.id === "job2")?.status === "done");
    expect(records(w.state)).toEqual([]);
    before.close();
    after.close();
  });

  test("a command that is gone is reported as ended, with what its output file holds, and is not run again", () => {
    const w = world();
    const marker = join(w.state, "starts.txt");
    const gone = Bun.spawnSync(["true"]);
    writeFileSync(join(w.state, "s1-job1.log"), "finished while away\n");
    writeFileSync(join(w.state, "s1-job1.json"), JSON.stringify({ id: "job1", session: "s1", title: "build", argv: ["sh", "-c", `echo start >> ${marker}`], pid: gone.pid, start: "12345", startedAt: Date.now() - 5000, file: join(w.state, "s1-job1.log"), wake: true, hits: 0 }));
    const after = w.again();
    after.recover();
    expect(after.list()).toMatchObject([{ id: "job1", status: "done", code: null }]);
    expect(after.news().map((x) => [x.id, x.ended, x.code])).toEqual([["job1", true, null]]);
    expect(after.read("job1")!.output).toContain("finished while away");
    expect(existsSync(marker)).toBe(false);
    expect(records(w.state)).toEqual([]);
    expect(w.events.filter((e) => e.ev === "job").map((e) => (e as { status: string }).status)).toEqual(["running", "done"]);
    after.close();
  });

  test("a process number that was given to another program is not the job: it is reported as gone and left alone", async () => {
    const w = world();
    const stranger = Bun.spawn(["sleep", "30"]);
    writeFileSync(join(w.state, "s1-job4.json"), JSON.stringify({ id: "job4", session: "s1", title: "old", argv: ["x"], pid: stranger.pid, start: "not-its-start-time", startedAt: Date.now(), file: join(w.state, "none.log"), wake: true, hits: 0 }));
    const after = w.again();
    after.recover();
    expect(after.list()).toMatchObject([{ id: "job4", status: "done", code: null }]);
    expect(alive(stranger.pid)).toBe(true);
    after.stop("job4");
    expect(alive(stranger.pid)).toBe(true);
    stranger.kill();
    after.close();
  });

  test("the record of the same process, by its real start time, is the job", () => {
    const start = processStart(process.pid);
    // Linux counts clock ticks since boot; macOS writes the date out, to the second.
    expect(start).toMatch(process.platform === "darwin" ? /\S/ : /^\d+$/);
    expect(processStart(process.pid)).toBe(start);
  });

  test("another conversation's jobs are not taken, and a record that cannot be read is dropped", async () => {
    const w = world();
    const other = w.again("s2");
    other.start(node("setInterval(() => {}, 1000)"), dir, "theirs");
    writeFileSync(join(w.state, "s1-job9.json"), "{ broken");
    const mine = w.again("s1");
    mine.recover();
    expect(mine.list()).toEqual([]);
    expect(existsSync(join(w.state, "s1-job9.json"))).toBe(false);
    other.close();
  });

  test("a job the person stopped, or the program stopped on its way out, is not there to take back", async () => {
    const w = world();
    const first = w.again();
    first.start(node("setInterval(() => {}, 1000)"), dir, "a");
    first.start(node("setInterval(() => {}, 1000)"), dir, "b");
    expect(records(w.state).length).toBe(2);
    first.stopAll();
    expect(records(w.state)).toEqual([]);
    await first.stopped(8000);
    first.close();
  });
});

const alive = (pid: number | undefined): boolean => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } };
