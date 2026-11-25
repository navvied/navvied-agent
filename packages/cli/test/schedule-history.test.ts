import { afterAll, describe, expect, test } from "bun:test";
import { CloudSchedule, runInfoOfCloud, saidOf } from "@navvied/engine";
import { parseCommand } from "@navvied/protocol";
import { JobRunner, type Finished, type runJob } from "../src/schedule-run.ts";
import { LATE_MS, ScheduleStore, runInfos, type Job } from "../src/schedules.ts";
import { remove, tempDir } from "./helpers.ts";

const dirs: string[] = [];
afterAll(() => { dirs.forEach(remove); });
const store = (): ScheduleStore => { const d = tempDir(); dirs.push(d); return new ScheduleStore(`${d}/schedules.json`); };
const make = (s: ScheduleStore): Job => s.add({ cron: "0 9 * * *", prompt: "summarise", cwd: "/tmp" }, 1_000) as Job;
const T = Date.UTC(2026, 10, 25, 9, 0);

describe("the history of a task", () => {
  test("a run keeps a short text of what it said, with secrets hidden, and the outcome is fine, failed or stopped", () => {
    const s = store(), j = make(s);
    s.markRun(j.id, T);
    s.finished(j.id, 0, "f1", T + 1, false, saidOf("All fine.\n\nKey is sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 end"));
    s.markRun(j.id, T + 10);
    s.finished(j.id, 2, undefined, T + 11, false, saidOf("boom"));
    s.markRun(j.id, T + 20);
    s.finished(j.id, null, undefined, T + 21, true, saidOf("[stopped: it was cancelled]"));
    s.markRun(j.id, T + 30);
    const runs = runInfos(s.list()[0]!, 10);
    expect(runs.map((r) => r.outcome)).toEqual(["running", "stopped", "failed", "fine"]);
    expect(runs[3]!.said).toContain("All fine.");
    expect(runs[3]!.said).not.toContain("sk-ant-api03");
    expect(runs[2]).toEqual({ at: T + 10, outcome: "failed", said: "boom" });
    expect(runInfos(s.list()[0]!, 2)).toHaveLength(2);
  });

  test("what it said is at most 200 characters and the store keeps at most 20 runs", () => {
    const said = saidOf("word ".repeat(200))!;
    expect(said.length).toBe(200);
    expect(said.endsWith("…")).toBe(true);
    expect(saidOf("  \n ")).toBeUndefined();
    const s = store(), j = make(s);
    for (let i = 0; i < 30; i++) { s.markRun(j.id, T + i * 1000); s.finished(j.id, 0, undefined, T + i * 1000 + 1, false, said); }
    expect(s.list()[0]!.runs).toHaveLength(20);
    expect(runInfos(s.list()[0]!, 20)[0]!.at).toBe(T + 29_000);
  });

  test("the runner records what the run said", async () => {
    const s = store(), j = make(s);
    const run = (async (job: Job) => ({ job, code: 1, text: "it failed\nbecause", file: "" }) satisfies Finished) as unknown as typeof runJob;
    const runner = new JobRunner(s, { env: {}, where: "/tmp", run, now: () => T });
    await runner.start(j);
    expect(runInfos(s.list()[0]!, 10)).toEqual([{ at: T, outcome: "failed", said: "it failed because" }]);
  });
});

describe("a missed run", () => {
  test("a start that is late records the due time as missed, and the next start on time clears it", () => {
    const s = store(), j = make(s);
    s.markRun(j.id, T + 3_600_000, T);
    expect(s.list()[0]!.missed).toEqual({ at: T, reason: "off" });
    expect(runInfos(s.list()[0]!, 1)[0]!.due).toBe(T);
    s.finished(j.id, 0, undefined, T + 3_700_000);
    expect(s.list()[0]!.missed).toBeDefined();
    s.markRun(j.id, T + 86_400_000, T + 86_400_000 - 5);
    expect(s.list()[0]!.missed).toBeUndefined();
  });

  test("a start within the grace time is not a miss", () => {
    const s = store(), j = make(s);
    s.markRun(j.id, T + LATE_MS - 1, T);
    expect(s.list()[0]!.missed).toBeUndefined();
  });
});

describe("the command and the cloud shape", () => {
  test("schedule.runs takes an id and a limit of 1 to 20", () => {
    expect(parseCommand('{"cmd":"schedule.runs","id":"ab12"}')).toEqual({ ok: true, value: { cmd: "schedule.runs", id: "ab12" } });
    expect(parseCommand('{"cmd":"schedule.runs","id":"ab12","limit":5}')).toEqual({ ok: true, value: { cmd: "schedule.runs", id: "ab12", limit: 5 } });
    expect(parseCommand('{"cmd":"schedule.runs","id":"ab12","limit":21}').ok).toBe(false);
    expect(parseCommand('{"cmd":"schedule.runs"}').ok).toBe(false);
  });

  test("a cloud run's note becomes the same short text, and its outcomes use the same words", () => {
    expect(runInfoOfCloud({ at: 5, outcome: "ok", note: "wrote the report" })).toEqual({ at: 5, outcome: "fine", said: "wrote the report" });
    expect(runInfoOfCloud({ at: 6, outcome: "missed", due: 4 })).toEqual({ at: 6, outcome: "missed", due: 4 });
    expect(runInfoOfCloud({ at: 7, outcome: "failed", note: "token=ghp_abcdefghijklmnopqrstuvwxyz0123456789" }).said).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz");
  });

  test("the cloud job's history asks the service and maps its runs, newest first, up to the limit", async () => {
    const server = Bun.serve({ port: 0, fetch: async () => Response.json({ jobs: [{ id: "j1", name: "n", prompt: "p", cron: "0 9 * * *", tz: "UTC", mode: "plan", enabled: true, runs: [{ at: 3, outcome: "ok", note: "a" }, { at: 2, outcome: "failed", note: "b" }, { at: 1, outcome: "ok" }] }] }) });
    try {
      const cloud = new CloudSchedule({ url: `http://127.0.0.1:${server.port}/v1/web`, token: "t" });
      expect(await cloud.history("j1", 2)).toEqual([{ at: 3, outcome: "fine", said: "a" }, { at: 2, outcome: "failed", said: "b" }]);
      expect(await cloud.history("none")).toEqual([]);
    } finally { server.stop(true); }
  });
});
