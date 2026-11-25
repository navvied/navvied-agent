import { afterAll, beforeAll, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { parseCommand } from "@navvied/protocol";
import { createHub } from "../src/commands/hub.ts";
import { folderId } from "../src/folders.ts";
import { fakeIO, remove, startMockModel, tempDir, until } from "./helpers.ts";

let mock: ReturnType<typeof startMockModel>;
const dirs: string[] = [];
beforeAll(() => { mock = startMockModel(); });
afterAll(() => { mock.stop(); dirs.forEach(remove); });

type Ev = { ev: string; [k: string]: unknown };
type Item = { id: string; lastCode?: number | null; missed?: { at: number; reason: string } };

test("a task is added in the forms the Schedule tool has, and listed back in the same form", async () => {
  const state = tempDir(), work = tempDir();
  dirs.push(state, work);
  const env = { HOME: state, XDG_STATE_HOME: state, NAVVIED_BASE_URL: mock.url, NAVVIED_MODEL: "mock-model", NAVVIED_WINDOW: "100000" };
  const hub = createHub({ json: false, yes: false, thinking: false, cwd: work } as never, fakeIO({ env }).io, { watch: false });
  const got: Ev[] = [];
  hub.attach({ send: (line) => { got.push(JSON.parse(String(line))); } }, 0);
  const send = (cmd: object): void => hub.command(JSON.stringify(cmd), () => undefined);
  type Full = { id: string; cron: string; when: unknown; tz?: string; next?: number };
  const items = (): Full[] => (got.filter((e) => e.ev === "schedules").at(-1) as unknown as { items: Full[] }).items;
  const at = Date.now() + 86_400_000;
  send({ cmd: "schedule.add", prompt: "a", when: { kind: "every", ms: 900_000 } });
  send({ cmd: "schedule.add", prompt: "b", when: { kind: "at", at } });
  send({ cmd: "schedule.add", prompt: "c", when: { kind: "cron", cron: "0 9 * * *" }, tz: "Asia/Jakarta" });
  send({ cmd: "schedule.add", prompt: "d", when: { kind: "every", ms: 1_209_600_000, start: at } });
  send({ cmd: "schedule.add", prompt: "e", cron: "@daily" });
  await until(() => items().length === 5).catch((e) => { console.log(JSON.stringify(got.filter((x) => x.ev === "error" || x.ev === "schedules").slice(-3))); throw e; });
  const by = (p: string): Full => items()[["a", "b", "c", "d", "e"].indexOf(p)]!;
  expect(by("a")).toMatchObject({ cron: "every 15m", when: { kind: "every", ms: 900_000 } });
  expect(by("b").when).toEqual({ kind: "at", at });
  expect(by("c")).toMatchObject({ when: { kind: "cron", cron: "0 9 * * *" }, tz: "Asia/Jakarta" });
  expect(by("d").when).toEqual({ kind: "every", ms: 1_209_600_000, start: at });
  expect(by("e").when).toEqual({ kind: "cron", cron: "@daily" });
  send({ cmd: "schedule.update", id: by("a").id, when: { kind: "cron", cron: "*/5 * * * *" } });
  await until(() => (items()[0]!.when as { kind: string }).kind === "cron");
  send({ cmd: "schedule.add", prompt: "h", when: { kind: "at", at }, tz: "Mars/Base" });
  await until(() => got.some((e) => e.ev === "error" && String(e.msg).includes("not a time zone")));
  await hub.stop();
});

test("the forms are checked", () => {
  const t = { cmd: "schedule.add", prompt: "x" };
  expect(parseCommand(JSON.stringify({ ...t, when: { kind: "every", ms: 1000 } })).ok).toBe(false);
  expect(parseCommand(JSON.stringify({ ...t, cron: "* * * * *", when: { kind: "at", at: 5 } })).ok).toBe(false);
  expect(parseCommand(JSON.stringify(t)).ok).toBe(false);
  expect(parseCommand(JSON.stringify({ ...t, when: { kind: "weekly" } })).ok).toBe(false);
  expect(parseCommand(JSON.stringify({ ...t, when: { kind: "every", ms: 900000, start: 5 }, tz: "UTC" })).ok).toBe(true);
  expect(parseCommand(JSON.stringify({ cmd: "schedule.update", id: "ab", tz: "UTC" })).ok).toBe(true);
});

test("schedule.runs answers with the newest runs and what they said; an unknown task is an error", async () => {
  const state = tempDir(), work = tempDir();
  dirs.push(state, work);
  const env = { HOME: state, XDG_STATE_HOME: state, NAVVIED_BASE_URL: mock.url, NAVVIED_MODEL: "mock-model", NAVVIED_WINDOW: "100000" };
  const runner = (async (job: { id: string }) => ({ job, code: 3, text: "could not reach the server", file: "" })) as never;
  const hub = createHub({ json: false, yes: false, thinking: false, cwd: work } as never, fakeIO({ env }).io, { watch: false, runner });
  const got: Ev[] = [];
  hub.attach({ send: (line) => { got.push(JSON.parse(String(line))); } }, 0);
  const send = (cmd: object): void => hub.command(JSON.stringify(cmd), () => undefined);
  const items = (): Item[] => (got.filter((e) => e.ev === "schedules").at(-1) as unknown as { items: Item[] }).items;
  send({ cmd: "schedule.add", cron: "0 9 * * *", prompt: "check", folder: folderId(realpathSync(work)) });
  await until(() => got.some((e) => e.ev === "schedules"));
  const id = items()[0]!.id;
  expect(items()[0]!.missed).toBeUndefined();
  send({ cmd: "schedule.run", id });
  await until(() => items()[0]!.lastCode === 3);
  send({ cmd: "schedule.runs", id });
  await until(() => got.some((e) => e.ev === "schedule.runs"));
  const runs = got.find((e) => e.ev === "schedule.runs") as unknown as { id: string; runs: { outcome: string; said?: string }[] };
  expect(runs.id).toBe(id);
  expect(runs.runs).toMatchObject([{ outcome: "failed", said: "could not reach the server" }]);
  send({ cmd: "schedule.runs", id: "nope" });
  await until(() => got.some((e) => e.ev === "error" && e.msg === "That task was not found."));
  await hub.stop();
});
