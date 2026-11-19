import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { matches, parseCron, dueSince } from "../src/cron.ts";
import { schedulesPath, scheduledDir } from "../src/config.ts";
import { main } from "../src/main.ts";
import { ScheduleStore, dueJobs } from "../src/schedules.ts";
import { fakeIO, remove, startMockModel, tempDir } from "./helpers.ts";

let mock: ReturnType<typeof startMockModel>;
const dirs: string[] = [];
beforeAll(() => { mock = startMockModel(); });
afterAll(() => { mock.stop(); dirs.forEach(remove); });

const at = (iso: string): Date => new Date(iso);
const cron = (e: string) => { const c = parseCron(e); if (typeof c === "string") throw new Error(c); return c; };

describe("schedules", () => {
  test("a schedule is five parts, with stars, lists, ranges and steps, and wrong ones say what is wrong", () => {
    expect(typeof parseCron("0 9 * * 1-5")).toBe("object");
    expect(parseCron("0 9 * *")).toContain("five parts");
    expect(parseCron("61 * * * *")).toContain("outside 0 to 59");
    expect(parseCron("*/0 * * * *")).toContain("at least 1");
    expect(parseCron("a * * * *")).toContain("not a valid minute");
    expect(typeof parseCron("@daily")).toBe("object");
  });
  test("it names the right minutes: weekdays at nine, every fifteen minutes, and day-of-month or weekday when both are given", () => {
    const weekdays = cron("0 9 * * 1-5");
    expect(matches(weekdays, at("2026-11-16T09:00:00"))).toBe(true);   // a Monday
    expect(matches(weekdays, at("2026-11-15T09:00:00"))).toBe(false);  // a Sunday
    expect(matches(weekdays, at("2026-11-16T09:01:00"))).toBe(false);
    const quarter = cron("*/15 * * * *");
    expect([0, 15, 30, 45].every((m) => matches(quarter, new Date(2026, 10, 16, 10, m)))).toBe(true);
    expect(matches(quarter, new Date(2026, 10, 16, 10, 20))).toBe(false);
    const either = cron("0 0 13 * 5");   // the 13th, or any Friday
    expect(matches(either, at("2026-11-13T00:00:00"))).toBe(true);
    expect(matches(either, at("2026-11-20T00:00:00"))).toBe(true);
    expect(matches(either, at("2026-11-17T00:00:00"))).toBe(false);
    expect(matches(cron("0 0 * * 7"), at("2026-11-15T00:00:00"))).toBe(true); // 7 is Sunday too
  });
  test("what came due since the last run is found, once, even after a long time away", () => {
    const c = cron("0 9 * * *");
    const nine = new Date(2026, 10, 16, 9, 0).getTime();
    expect(dueSince(c, nine - 3_600_000, nine + 60_000)).toBe(nine);
    expect(dueSince(c, nine, nine + 3_600_000)).toBeUndefined();
    expect(dueSince(c, nine - 20 * 86_400_000, nine + 60_000)).toBeDefined();
  });
});

describe("the tasks that are kept", () => {
  test("adding, listing and removing; a bad schedule or an empty task is refused; and due ones are found", () => {
    const dir = tempDir(); dirs.push(dir);
    const store = new ScheduleStore(join(dir, "s.json"));
    const t0 = new Date(2026, 10, 16, 8, 30).getTime();
    expect(store.add({ cron: "nonsense", prompt: "x", cwd: dir })).toContain("five parts");
    expect(store.add({ cron: "0 9 * * *", prompt: "  ", cwd: dir })).toContain("what the task is");
    const job = store.add({ cron: "0 9 * * *", prompt: "summarise", cwd: dir }, t0);
    if (typeof job === "string") throw new Error(job);
    expect(job.mode).toBe("plan");
    expect(dueJobs(store.list(), t0 + 10 * 60_000)).toEqual([]);
    expect(dueJobs(store.list(), t0 + 40 * 60_000).map((j) => j.id)).toEqual([job.id]);
    store.markRun(job.id, t0 + 40 * 60_000);
    expect(dueJobs(store.list(), t0 + 50 * 60_000)).toEqual([]);
    expect(store.remove(job.id)).toBe(true);
    expect(store.remove(job.id)).toBe(false);
  });
});

describe("navvied schedule", () => {
  const env = (dir: string) => ({ HOME: dir, XDG_STATE_HOME: dir, NAVVIED_BASE_URL: mock.url, NAVVIED_MODEL: "mock-model", NAVVIED_WINDOW: "100000" });

  test("add, list and remove from the command line, with plain errors", async () => {
    const dir = tempDir(); dirs.push(dir);
    const run = async (...args: string[]) => { const f = fakeIO({ env: env(dir) }); const code = await main(["schedule", ...args, "--cwd", dir], f.io); return { code, out: f.out(), err: f.err() }; };
    const added = await run("add", "0 9 * * 1-5", "summarise", "yesterday's", "commits");
    expect(added.code).toBe(0);
    const id = /Scheduled (\w+):/.exec(added.out)![1]!;
    expect((await run("list")).out).toContain("summarise yesterday's commits");
    expect((await run("add", "0 9 * *", "x")).code).toBe(2);
    expect((await run("remove", "nope")).code).toBe(1);
    expect((await run("remove", id)).code).toBe(0);
    expect((await run("list")).out).toContain("No scheduled tasks");
  });
  test("run-due starts what is due as a real run in its own process, keeps what it said, and then nothing is due", async () => {
    const dir = tempDir(); dirs.push(dir);
    const store = new ScheduleStore(schedulesPath(env(dir)));
    const job = store.add({ cron: "* * * * *", prompt: "say hello", cwd: dir }, Date.now() - 5 * 60_000);
    if (typeof job === "string") throw new Error(job);
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "../src/main.ts"), "schedule", "run-due", "--cwd", dir], { env: { ...process.env, ...env(dir) }, stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(out).toContain(`${job.id}: done`);
    const kept = join(scheduledDir(env(dir)), job.id);
    expect(existsSync(kept)).toBe(true);
    const file = readdirSync(kept)[0]!;
    expect(readFileSync(join(kept, file), "utf8")).toContain("say hello");
    expect(store.list()[0]!.lastRun).toBeGreaterThan(Date.now() - 60_000);
    writeFileSync(join(dir, "unused"), "");
    const again = Bun.spawn([process.execPath, join(import.meta.dir, "../src/main.ts"), "schedule", "run-due", "--cwd", dir], { env: { ...process.env, ...env(dir) }, stdout: "pipe", stderr: "pipe" });
    expect(await new Response(again.stdout).text()).toContain("Nothing is due");
  }, 30_000);
});
