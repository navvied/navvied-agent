import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { CloudSchedule, Jobs, defaultTools, type ToolContext } from "@navvied/engine";
import { ComputerSchedule, scheduleFor } from "../src/schedule-tool.ts";
import { LATE_MS, ScheduleStore, UNATTENDED, dueAt, dueJobs, nextDue, timingText } from "../src/schedules.ts";
import { remove, tempDir } from "./helpers.ts";

const dirs: string[] = [];
afterAll(() => { dirs.forEach(remove); });
const open = () => { const dir = tempDir(); dirs.push(dir); return { dir, store: new ScheduleStore(join(dir, "s.json")) }; };
const ok = <T>(v: T | string): T => { if (typeof v === "string") throw new Error(v); return v; };

const T0 = Date.UTC(2026, 10, 25, 8, 0);
const MIN = 60_000, HOUR = 3_600_000;

describe("the timings a task can have", () => {
  test("every counts from the last start; a one-time task is due once, at its time", () => {
    const { dir, store } = open();
    const every = ok(store.add({ every: 2 * HOUR, prompt: "p", cwd: dir }, T0));
    expect(dueAt(every, T0 + 2 * HOUR - 1)).toBeUndefined();
    expect(dueAt(every, T0 + 2 * HOUR)).toBe(T0 + 2 * HOUR);
    // Away for a day: it starts once, and the time it was due is the first one it missed.
    expect(dueAt(every, T0 + 24 * HOUR)).toBe(T0 + 2 * HOUR);
    store.markRun(every.id, T0 + 24 * HOUR, T0 + 2 * HOUR);
    expect(dueAt(store.list()[0]!, T0 + 25 * HOUR)).toBeUndefined();
    expect(dueAt(store.list()[0]!, T0 + 26 * HOUR)).toBe(T0 + 26 * HOUR);

    const once = ok(store.add({ at: T0 + 20 * MIN, prompt: "once", cwd: dir }, T0));
    expect(dueAt(once, T0 + 19 * MIN)).toBeUndefined();
    expect(nextDue(once, T0)).toBe(T0 + 20 * MIN);
    expect(dueAt(once, T0 + 3 * HOUR)).toBe(T0 + 20 * MIN);
    store.markRun(once.id, T0 + 3 * HOUR, T0 + 20 * MIN);
    const after = store.list().find((j) => j.id === once.id)!;
    expect(dueAt(after, T0 + 9 * HOUR)).toBeUndefined();
    expect(nextDue(after, T0 + 9 * HOUR)).toBeUndefined();
  });

  test("a cron is read in its time zone", () => {
    const { dir, store } = open();
    const job = ok(store.add({ cron: "0 9 * * *", tz: "Asia/Jakarta", prompt: "p", cwd: dir }, Date.UTC(2026, 10, 24, 12)));
    expect(dueAt(job, Date.UTC(2026, 10, 25, 1, 59))).toBeUndefined();
    expect(dueAt(job, Date.UTC(2026, 10, 25, 2, 0))).toBe(Date.UTC(2026, 10, 25, 2, 0));
    expect(nextDue(job, Date.UTC(2026, 10, 25, 3))).toBe(Date.UTC(2026, 10, 26, 2, 0));
  });

  test("a task that was due while nothing ran starts once, and the run says when it was due; a start on time says nothing", () => {
    const { dir, store } = open();
    const job = ok(store.add({ cron: "0 9 * * *", tz: "UTC", prompt: "p", cwd: dir }, Date.UTC(2026, 10, 24, 12)));
    const now = Date.UTC(2026, 10, 26, 15, 0);
    const due = dueAt(job, now)!;
    expect(due).toBe(Date.UTC(2026, 10, 25, 9, 0));
    expect(dueJobs([job], now)).toHaveLength(1);
    store.markRun(job.id, now, due);
    store.finished(job.id, 0, "/kept/a.txt", now + 1000);
    expect(store.list()[0]!.runs![0]).toEqual({ at: now, due, code: 0, file: "/kept/a.txt" });
    expect(dueAt(store.list()[0]!, now + HOUR)).toBeUndefined();
    const t = Date.UTC(2026, 10, 27, 9, 0, 30);
    store.markRun(job.id, t, Date.UTC(2026, 10, 27, 9, 0));
    expect(t - Date.UTC(2026, 10, 27, 9, 0)).toBeLessThan(LATE_MS);
    expect(store.list()[0]!.runs![0]).toEqual({ at: t });
  });

  test("the newest twenty starts are kept, newest first, and a run started by hand is a start of its own", () => {
    const { dir, store } = open();
    const job = ok(store.add({ every: HOUR, prompt: "p", cwd: dir }, T0));
    for (let i = 0; i < 25; i++) { store.markRun(job.id, T0 + i * HOUR); store.finished(job.id, i % 2, undefined, T0 + i * HOUR); }
    const runs = store.list()[0]!.runs!;
    expect(runs).toHaveLength(20);
    expect(runs[0]).toMatchObject({ at: T0 + 24 * HOUR, code: 0 });
    expect(runs[19]!.at).toBe(T0 + 5 * HOUR);
    store.finished(job.id, 1, "f", T0 + 99 * HOUR);
    expect(store.list()[0]!.runs![0]).toMatchObject({ at: T0 + 99 * HOUR, code: 1 });
    expect(store.list()[0]!.lastCode).toBe(1);
  });

  test("bad timings are refused in words, and changing the timing replaces the old one and restarts the count", () => {
    const { dir, store } = open();
    expect(store.add({ every: 30_000, prompt: "p", cwd: dir })).toContain("once every 60 seconds");
    expect(store.add({ cron: "0 9 * * *", every: HOUR, prompt: "p", cwd: dir })).toContain("one schedule");
    expect(store.add({ prompt: "p", cwd: dir })).toContain("one schedule");
    expect(store.add({ cron: "0 9 * * *", tz: "Mars/Base", prompt: "p", cwd: dir })).toContain("not a time zone");
    const job = ok(store.add({ cron: "0 9 * * *", prompt: "p", cwd: dir }, T0));
    const changed = ok(store.update(job.id, { every: 3 * HOUR }, T0 + 5 * HOUR));
    expect(changed).toMatchObject({ cron: "", every: 3 * HOUR, from: T0 + 5 * HOUR });
    expect(timingText(changed)).toBe("every 3h");
    expect(dueAt(changed, T0 + 7 * HOUR)).toBeUndefined();
    expect(dueAt(changed, T0 + 8 * HOUR)).toBe(T0 + 8 * HOUR);
    expect(store.update(job.id, { cron: "nonsense" }, T0)).toContain("five parts");
  });

  test("a task turned back on is not made up for", () => {
    const { dir, store } = open();
    const job = ok(store.add({ every: HOUR, prompt: "p", cwd: dir }, T0));
    store.update(job.id, { enabled: false }, T0 + MIN);
    expect(dueAt(store.list()[0]!, T0 + 10 * HOUR)).toBeUndefined();
    store.update(job.id, { enabled: true }, T0 + 10 * HOUR);
    expect(dueAt(store.list()[0]!, T0 + 10 * HOUR + MIN)).toBeUndefined();
    expect(dueAt(store.list()[0]!, T0 + 11 * HOUR)).toBe(T0 + 11 * HOUR);
  });

  test("the words for each timing", () => {
    const { dir, store } = open();
    expect(timingText(ok(store.add({ every: 90 * MIN, prompt: "a", cwd: dir })))).toBe("every 90m");
    expect(timingText(ok(store.add({ every: 2 * 86_400_000, prompt: "a", cwd: dir })))).toBe("every 2d");
    expect(timingText(ok(store.add({ at: T0 + HOUR, prompt: "a", cwd: dir })))).toBe("once 2026-11-25 09:00 UTC");
    expect(timingText(ok(store.add({ cron: "@daily", prompt: "a", cwd: dir })))).toBe("@daily");
  });
});

describe("the Schedule tool on this computer", () => {
  const tool = defaultTools().find((t) => t.name === "Schedule")!;
  const ctx = (schedule: ComputerSchedule): ToolContext => ({ cwd: ".", signal: new AbortController().signal, emit: () => undefined, allowPrivateNetwork: false, jobs: new Jobs(() => undefined), schedule });
  const run = (args: Record<string, unknown>, c: ToolContext) => tool.run(tool.fixArgs!(args), c);

  test("it makes a job in the file of tasks, with a clock it is given, and the person's own list sees it", async () => {
    const { dir, store } = open();
    let said = 0;
    const c = ctx(new ComputerSchedule(store, { cwd: dir, chat: false, canChange: true, now: () => T0, changed: () => { said++; } }));
    const made = await run({ action: "create", name: "digest", prompt: "summarise the commits", when: "in 20 minutes" }, c);
    expect(made).toContain("once 2026-11-25 08:20 UTC");
    expect(made).toContain("It runs only while navvied is open on this computer.");
    const job = store.list()[0]!;
    expect(job).toMatchObject({ title: "digest", at: T0 + 20 * MIN, mode: "plan", cwd: dir, cron: "" });
    expect(job.kind).toBeUndefined();
    await run({ action: "create", prompt: "tidy", when: "weekdays at 9", tz: "Asia/Jakarta", mode: "auto" }, c);
    expect(store.list()[1]).toMatchObject({ cron: "0 9 * * 1-5", tz: "Asia/Jakarta", mode: "auto" });
    expect(await run({ action: "update", id: "digest", when: "every 2h" }, c)).toContain("every 2h");
    expect(await run({ action: "pause", id: store.list()[1]!.id }, c)).toContain("paused");
    expect(store.list()[1]!.disabled).toBe(true);
    expect(await run({ action: "remove", id: "digest" }, c)).toContain("Removed");
    expect(store.list()).toHaveLength(1);
    expect(said).toBe(5);
  });

  test("the most jobs and a bad schedule are refused in plain sentences", async () => {
    const { dir, store } = open();
    const c = ctx(new ComputerSchedule(store, { cwd: dir, chat: false, canChange: true, now: () => T0 }));
    expect(await run({ action: "create", prompt: "x", when: "every 5s" }, c)).toContain("once every 60 seconds");
    for (let i = 0; i < 50; i++) ok(store.add({ cron: "0 9 * * *", prompt: `p${i}`, cwd: dir }, T0));
    expect(await run({ action: "create", prompt: "one more", when: "daily at 09:00" }, c)).toBe("Error: At most 50 jobs are kept. Remove one first.");
  });

  test("the last outcome and the newest runs show, with a missed run's due time and where its output is kept", async () => {
    const { dir, store } = open();
    const c = ctx(new ComputerSchedule(store, { cwd: dir, chat: false, canChange: true, now: () => T0 + 5 * HOUR }));
    const job = ok(store.add({ cron: "0 9 * * *", tz: "UTC", title: "digest", prompt: "p", cwd: dir }, T0 - 30 * HOUR));
    store.markRun(job.id, T0 + 4 * HOUR, T0 - 15 * HOUR);
    expect(await run({ action: "list" }, c)).toContain("last running");
    store.finished(job.id, 0, join(dir, "out.txt"), T0 + 4 * HOUR);
    store.markRun(job.id, T0 + 4 * HOUR + 1, undefined);
    store.finished(job.id, 2, undefined, T0 + 4 * HOUR + 2);
    expect(await run({ action: "list" }, c)).toContain("last failed 2026-11-25 12:00 UTC");
    const runs = (await run({ action: "runs", id: job.id }, c)).split("\n");
    expect(runs[0]).toBe("2026-11-25 12:00 UTC failed");
    expect(runs[1]).toBe(`2026-11-25 12:00 UTC ok (missed: it was due 2026-11-24 17:00 UTC and started late): what it said is kept in ${join(dir, "out.txt")}`);
  });

  test("inside a run nobody started, and in a chat", async () => {
    const { dir, store } = open();
    ok(store.add({ cron: "0 9 * * *", prompt: "keep", cwd: dir }, T0));
    const looking = ctx(new ComputerSchedule(store, { cwd: dir, chat: false, canChange: false, now: () => T0 }));
    expect(await run({ action: "list" }, looking)).toContain("keep");
    expect(await run({ action: "remove", id: store.list()[0]!.id }, looking)).toContain("cannot change the jobs");
    expect(store.list()).toHaveLength(1);
    const chat = ctx(new ComputerSchedule(store, { cwd: dir, chat: true, canChange: true, now: () => T0 }));
    await run({ action: "create", prompt: "a chat job", when: "daily at 08:00" }, chat);
    expect(store.list().at(-1)!.kind).toBe("chat");
  });
});

describe("which jobs a conversation keeps", () => {
  const base = { file: "/nowhere/s.json", cwd: ".", chat: false };
  test("a hosted session has the cloud's, a computer its own, and a run nobody started may only look", () => {
    expect(scheduleFor({ ...base, env: {}, webProxy: { url: "http://127.0.0.1:1/v1/web", token: "t" } })).toBeInstanceOf(CloudSchedule);
    const own = scheduleFor({ ...base, env: {} });
    expect(own).toBeInstanceOf(ComputerSchedule);
    expect(own.canChange).toBe(true);
    expect(scheduleFor({ ...base, env: { [UNATTENDED]: "1" } }).canChange).toBe(false);
  });
});
