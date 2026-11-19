import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHub } from "../src/commands/hub.ts";
import { fakeIO, remove, startMockModel, tempDir, until } from "./helpers.ts";

let mock: ReturnType<typeof startMockModel>;
const dirs: string[] = [];
const hubs: { stop(): Promise<void> }[] = [];
// The scripted model answers slowly on purpose and the tests wait up to 30 s for it; the default five seconds is shorter than that wait.
setDefaultTimeout(60_000);
beforeAll(() => { mock = startMockModel(); });
// Every hub is stopped before its folders are removed, also one whose test stopped early: a running hub holds its files open.
afterAll(async () => { await Promise.all(hubs.map((h) => h.stop())); mock.stop(); dirs.forEach(remove); });

type Ev = { ev: string; id?: string; bg?: string; items?: { id: string; state?: string; unread?: boolean; running?: boolean }[]; msg?: string; text?: string; qid?: string; [k: string]: unknown };

function open() {
  const state = tempDir(), work = tempDir();
  dirs.push(state, work);
  const env = { HOME: state, XDG_STATE_HOME: state, XDG_CONFIG_HOME: state, NAVVIED_BASE_URL: mock.url, NAVVIED_MODEL: "mock-model", NAVVIED_WINDOW: "100000" };
  const hub = createHub({ json: false, yes: false, thinking: false, cwd: work } as never, fakeIO({ env }).io, { watch: false });
  hubs.push(hub);
  const got: Ev[] = [];
  hub.attach({ send: (line) => { got.push(JSON.parse(String(line))); } }, 0);
  const send = (cmd: object): void => hub.command(JSON.stringify(cmd), () => undefined);
  const sessionIds = (): string[] => got.filter((e) => e.ev === "session" && !e.bg).map((e) => e.id!);
  const lastSessions = (): NonNullable<Ev["items"]> => (got.filter((e) => e.ev === "sessions").at(-1)?.items ?? []);
  const lastBackground = (): NonNullable<Ev["items"]> => (got.filter((e) => e.ev === "background").at(-1)?.items ?? []);
  return { hub, got, send, sessionIds, lastSessions, lastBackground };
}

describe("several conversations at once on one computer", () => {
  test("opening a new conversation while one is being answered does not stop it: it goes on in the background and is marked unread when done", async () => {
    const r = open();
    r.send({ cmd: "prompt", text: "slow one", qid: "q1" });
    await until(() => r.got.some((e) => e.ev === "taken" && e.qid === "q1"));
    const first = r.sessionIds().at(-1)!;
    r.send({ cmd: "new" });
    await until(() => r.sessionIds().length === 2);
    expect(r.got.some((e) => e.ev === "error")).toBe(false);
    const second = r.sessionIds().at(-1)!;
    expect(second).not.toBe(first);
    expect(r.lastBackground()).toEqual([{ id: first, state: "working" }]);
    expect(r.lastSessions().find((s) => s.id === first)).toMatchObject({ running: true });
    // The new one is answered while the first is still being written.
    r.send({ cmd: "prompt", text: "a quick one", qid: "q2" });
    await until(() => r.got.some((e) => e.ev === "done" && !e.bg));
    expect(r.got.some((e) => e.bg === first && e.ev === "done")).toBe(false);
    // The first finishes in the background: its words carry its id, nobody is told it is the open one, and it is unread.
    await until(() => r.got.some((e) => e.bg === first && e.ev === "done"), 30_000);
    // What it said before the switch was drawn in front; what it says after carries its id (how much of each depends on how fast the machine is).
    expect(r.got.filter((e) => e.bg === first && e.ev === "text").map((e) => e.text).join("")).toContain("answering");
    await until(() => r.lastBackground().length === 0, 20_000);
    await until(() => r.lastSessions().find((s) => s.id === first)?.unread === true, 20_000);
    expect(r.lastSessions().find((s) => s.id === first)!.running).toBeUndefined();
    await r.hub.stop();
  });

  test("opening it again while it is still being answered brings it back, with the turn so far, and the answer carries on in front", async () => {
    const r = open();
    r.send({ cmd: "prompt", text: "slow two", qid: "q1" });
    await until(() => r.got.some((e) => e.ev === "text"));
    const first = r.sessionIds().at(-1)!;
    r.send({ cmd: "new" });
    await until(() => r.sessionIds().length === 2);
    const before = r.got.length;
    r.send({ cmd: "load", id: first });
    await until(() => r.got.slice(before).some((e) => e.ev === "loaded" && e.id === first));
    const shown = r.got.slice(before);
    // What came before the switch is shown again, in order, and what follows is not marked as background.
    const loadedAt = shown.findIndex((e) => e.ev === "loaded");
    expect(shown.slice(loadedAt + 1).some((e) => e.ev === "taken")).toBe(true);
    await until(() => r.got.slice(before + loadedAt).some((e) => e.ev === "done" && !e.bg), 10_000);
    expect(r.lastBackground()).toEqual([]);
    await r.hub.stop();
  });

  test("only so many may be answered in the background at once, and the person is told in plain words", async () => {
    const r = open();
    for (let i = 0; i < 5; i++) {
      r.send({ cmd: "prompt", text: `slow number ${i}`, qid: `q${i}` });
      await until(() => r.got.some((e) => e.ev === "taken" && e.qid === `q${i}`));
      r.send({ cmd: "new" });
      if (i < 4) await until(() => r.sessionIds().length === i + 2);
    }
    await until(() => r.got.some((e) => e.ev === "error" && e.msg === "Too many conversations are running. Wait for one to finish."));
    expect(r.lastBackground()).toHaveLength(4);
    await r.hub.stop();
  });

  test("a window that arrives is told what is going on in the background, and a conversation that is going on cannot be deleted", async () => {
    const r = open();
    r.send({ cmd: "prompt", text: "slow three", qid: "q1" });
    await until(() => r.got.some((e) => e.ev === "taken"));
    const first = r.sessionIds().at(-1)!;
    r.send({ cmd: "new" });
    await until(() => r.sessionIds().length === 2);
    r.send({ cmd: "remove", id: first });
    await until(() => r.got.some((e) => e.ev === "error" && /before deleting/.test(e.msg ?? "")));
    const late: Ev[] = [];
    r.hub.attach({ send: (l) => { late.push(JSON.parse(String(l))); } }, 0);
    const bg = late.findIndex((e) => e.ev === "background");
    const synced = late.findIndex((e) => e.ev === "synced");
    expect(bg).toBeGreaterThanOrEqual(0);
    expect(bg).toBeLessThan(synced);
    expect(late[bg]!.items).toEqual([{ id: first, state: "working" }]);
    await r.hub.stop();
  });
});

describe("the list of conversations follows what is said", () => {
  test("a new conversation is in the list as soon as its first message is taken, and the list is sent again when the answer is done", async () => {
    const r = open();
    r.send({ cmd: "prompt", text: "slow four", qid: "q1" });
    await until(() => r.got.some((e) => e.ev === "taken"));
    const id = r.sessionIds().at(-1)!;
    await until(() => r.lastSessions().some((s) => s.id === id));
    const lists = r.got.filter((e) => e.ev === "sessions").length;
    await until(() => r.got.some((e) => e.ev === "done"), 10_000);
    await until(() => r.got.filter((e) => e.ev === "sessions").length > lists);
    expect(r.lastSessions().find((s) => s.id === id)).toMatchObject({ title: "slow four", messages: expect.any(Number) });
    await r.hub.stop();
  });
});
