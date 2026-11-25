import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync } from "node:fs";
import { createHub } from "../src/commands/hub.ts";
import { folderId } from "../src/folders.ts";
import { nextRun, parseCron } from "../src/cron.ts";
import { fakeIO, remove, startMockModel, tempDir, until } from "./helpers.ts";

let mock: ReturnType<typeof startMockModel>;
const dirs: string[] = [];
beforeAll(() => { mock = startMockModel(); });
afterAll(() => { mock.stop(); dirs.forEach(remove); });

type Ev = { ev: string; [k: string]: unknown };
type Item = { id: string; title: string; prompt: string; cron: string; next?: number; last?: number; lastCode?: number | null; enabled: boolean; folder?: { id: string; name: string }; kind: string; mode: string; running?: boolean };

describe("when a schedule runs next", () => {
  test("the next minute that the five fields name, in local time, looking ahead as far as a year", () => {
    const at = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi).getTime();
    const c = (text: string) => parseCron(text) as Exclude<ReturnType<typeof parseCron>, string>;
    expect(nextRun(c("30 9 * * *"), at(2026, 11, 17, 8, 0))).toBe(at(2026, 11, 17, 9, 30));
    expect(nextRun(c("30 9 * * *"), at(2026, 11, 17, 9, 30))).toBe(at(2026, 11, 18, 9, 30));
    expect(nextRun(c("*/15 * * * *"), at(2026, 11, 17, 8, 7))).toBe(at(2026, 11, 17, 8, 15));
    expect(nextRun(c("0 9 * * 1-5"), at(2026, 11, 20, 10, 0))).toBe(at(2026, 11, 23, 9, 0)); // Friday -> Monday
    expect(nextRun(c("0 0 1 1 *"), at(2026, 11, 17, 0, 0))).toBe(at(2027, 1, 1, 0, 0));
  });
});

describe("scheduled tasks through the hub", () => {
  function open(runner?: never) {
    const state = tempDir(), work = tempDir();
    dirs.push(state, work);
    const env = { HOME: state, XDG_STATE_HOME: state, NAVVIED_BASE_URL: mock.url, NAVVIED_MODEL: "mock-model", NAVVIED_WINDOW: "100000" };
    const ran: string[] = [];
    const hub = createHub({ json: false, yes: false, thinking: false, cwd: work } as never, fakeIO({ env }).io, { watch: false, runner: runner ?? ((async (job: { id: string; prompt: string }) => { ran.push(job.prompt); await new Promise((r) => setTimeout(r, 150)); return { job, code: 0, text: "done", file: "x" }; }) as never) });
    const got: Ev[] = [];
    hub.attach({ send: (line) => { got.push(JSON.parse(String(line))); } }, 0);
    const send = (cmd: object): void => hub.command(JSON.stringify(cmd), () => undefined);
    const last = (): Item[] => (got.filter((e) => e.ev === "schedules").at(-1) as unknown as { items: Item[] }).items;
    return { hub, got, send, last, work: realpathSync(work), ran };
  }

  test("the hub says it keeps schedules, and when they run", async () => {
    const { hub, got } = open();
    const caps = got.find((e) => e.ev === "caps") as unknown as { schedule?: boolean; scheduleNote?: string };
    expect(caps.schedule).toBe(true);
    expect(caps.scheduleNote).toContain("only while this computer is on");
    await hub.stop();
  });

  test("a task is added in a folder the computer offers, listed with its next time, changed, turned off, run by hand, and removed", async () => {
    const { hub, got, send, last, work, ran } = open();
    send({ cmd: "schedule.add", title: "Morning summary", cron: "0 9 * * *", prompt: "summarise yesterday's commits", folder: folderId(work) });
    await until(() => got.some((e) => e.ev === "schedules"));
    expect(last()).toHaveLength(1);
    const job = last()[0]!;
    expect(job).toMatchObject({ title: "Morning summary", cron: "0 9 * * *", enabled: true, kind: "agent", mode: "plan", folder: { id: folderId(work) } });
    expect(job.next).toBeGreaterThan(Date.now());

    send({ cmd: "schedule.update", id: job.id, cron: "30 18 * * *", mode: "auto" });
    await until(() => last()[0]!.cron === "30 18 * * *");
    expect(last()[0]).toMatchObject({ mode: "auto" });
    send({ cmd: "schedule.update", id: job.id, enabled: false });
    await until(() => last()[0]!.enabled === false);
    expect(last()[0]!.next).toBeUndefined();

    send({ cmd: "schedule.run", id: job.id });
    await until(() => last()[0]!.running === true);
    await until(() => last()[0]!.running === undefined && last()[0]!.lastCode === 0);
    expect(ran).toEqual(["summarise yesterday's commits"]);
    expect(last()[0]!.last).toBeGreaterThan(0);

    send({ cmd: "schedule.remove", id: job.id });
    await until(() => last().length === 0);
    await hub.stop();
  });

  test("a folder that is not offered, a bad schedule and an empty task are refused with a reason; a chat task has no folder", async () => {
    const { hub, got, send, last } = open();
    const errors = () => got.filter((e) => e.ev === "error").map((e) => e.msg as string);
    send({ cmd: "schedule.add", cron: "0 9 * * *", prompt: "x", folder: "/etc" });
    await until(() => errors().length >= 1);
    expect(errors()[0]).toBe("That folder is not offered by this computer.");
    send({ cmd: "schedule.add", cron: "not a schedule", prompt: "x" });
    await until(() => errors().length >= 2);
    expect(errors()[1]).toStartWith("The task was not saved:");
    send({ cmd: "schedule.update", id: "nope", enabled: false });
    await until(() => errors().length >= 3);
    expect(errors()[2]).toContain("not changed");
    send({ cmd: "schedule.add", kind: "chat", cron: "@daily", prompt: "write a joke" });
    await until(() => got.some((e) => e.ev === "schedules"));
    expect(last()[0]).toMatchObject({ kind: "chat" });
    expect(last()[0]!.folder).toBeUndefined();
    await hub.stop();
  });

  test("when the hub runs tasks, one that is due starts by itself, once", async () => {
    const state = tempDir(), work = tempDir();
    dirs.push(state, work);
    const env = { HOME: state, XDG_STATE_HOME: state, NAVVIED_BASE_URL: mock.url, NAVVIED_MODEL: "mock-model", NAVVIED_WINDOW: "100000" };
    // A task that came due while nothing was running, from the file the computer keeps.
    const first = createHub({ json: false, yes: false, thinking: false, cwd: work } as never, fakeIO({ env }).io, { watch: false });
    first.command(JSON.stringify({ cmd: "schedule.add", cron: "* * * * *", prompt: "every minute", folder: folderId(work) }), () => undefined);
    await first.stop();
    const { writeFileSync, readFileSync } = await import("node:fs");
    const { schedulesPath } = await import("../src/config.ts");
    const file = schedulesPath(env);
    const data = JSON.parse(readFileSync(file, "utf8")) as { jobs: { created: number; lastRun?: number }[] };
    data.jobs[0]!.created = Date.now() - 10 * 60_000;
    data.jobs[0]!.lastRun = Date.now() - 10 * 60_000;
    writeFileSync(file, JSON.stringify(data));
    const ran: string[] = [];
    const hub = createHub({ json: false, yes: false, thinking: false, cwd: work } as never, fakeIO({ env }).io, { watch: false, schedule: true, runner: (async (job: { prompt: string }) => { ran.push(job.prompt); return { job, code: 0, text: "", file: "" }; }) as never });
    await until(() => ran.length === 1);
    await new Promise((r) => setTimeout(r, 200));
    expect(ran).toEqual(["every minute"]);
    await until(() => (JSON.parse(readFileSync(file, "utf8")) as { jobs: { runs?: { code?: number }[] }[] }).jobs[0]!.runs?.[0]?.code === 0);
    const kept = (JSON.parse(readFileSync(file, "utf8")) as { jobs: { runs: { at: number; due?: number }[] }[] }).jobs[0]!.runs;
    expect(kept).toHaveLength(1);
    expect(kept[0]!.due).toBeLessThan(Date.now() - 5 * 60_000);
    await hub.stop();
  });
});
