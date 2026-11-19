import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parseCommand } from "@navvied/protocol";
import { createHub } from "../src/commands/hub.ts";
import { DraftStore } from "../src/drafts.ts";
import { fakeIO, remove, startMockModel, tempDir, until } from "./helpers.ts";

let mock: ReturnType<typeof startMockModel>;
const dirs: string[] = [];
beforeAll(() => { mock = startMockModel(); });
afterAll(() => { mock.stop(); dirs.forEach(remove); });

describe("what the person typed and did not send", () => {
  test("it is kept per conversation, replaced by newer text, and taken away by empty text", () => {
    const dir = tempDir(); dirs.push(dir);
    let now = 1000;
    const store = new DraftStore(join(dir, "drafts.json"), () => now);
    store.set("c1", "hello wor");
    now = 2000;
    store.set("new", "another idea");
    now = 3000;
    store.set("c1", "hello world");
    expect(store.list().map((d) => [d.key, d.text])).toEqual([["c1", "hello world"], ["new", "another idea"]]);
    store.set("new", "");
    expect(new DraftStore(join(dir, "drafts.json")).list()).toEqual([{ key: "c1", text: "hello world", updated: 3000 }]);
  });

  test("only so many are kept, the newest", () => {
    const dir = tempDir(); dirs.push(dir);
    let now = 0;
    const store = new DraftStore(join(dir, "drafts.json"), () => ++now);
    for (let i = 0; i < 130; i++) store.set(`c${i}`, `text ${i}`);
    expect(store.list()).toHaveLength(100);
    expect(store.list()[0]!.key).toBe("c129");
  });

  test("the command accepts a conversation id or new, and text up to a limit, and nothing else", () => {
    expect(parseCommand('{"cmd":"draft","key":"new","text":"x"}').ok).toBe(true);
    expect(parseCommand('{"cmd":"draft","key":"abc-123_x","text":""}').ok).toBe(true);
    expect(parseCommand('{"cmd":"draft","key":"../etc","text":"x"}').ok).toBe(false);
    expect(parseCommand(`{"cmd":"draft","key":"new","text":"${"a".repeat(20_001)}"}`).ok).toBe(false);
    expect(parseCommand('{"cmd":"draft","key":"new"}').ok).toBe(false);
    expect(parseCommand('{"cmd":"drafts"}').ok).toBe(true);
  });

  test("every window is told at once, and a window that comes later asks and finds it, also after the hub restarts", async () => {
    const state = tempDir(), work = tempDir(); dirs.push(state, work);
    const env = { HOME: state, XDG_STATE_HOME: state, XDG_CONFIG_HOME: state, NAVVIED_BASE_URL: mock.url, NAVVIED_MODEL: "mock-model", NAVVIED_WINDOW: "100000" };
    const make = () => createHub({ json: false, yes: false, thinking: false, cwd: work } as never, fakeIO({ env }).io, { watch: false });
    const hub = make();
    const phone: { ev: string; items?: { key: string; text: string }[] }[] = [], laptop: typeof phone = [];
    hub.attach({ send: (l) => { phone.push(JSON.parse(String(l))); } }, 0);
    hub.attach({ send: (l) => { laptop.push(JSON.parse(String(l))); } }, 0);
    hub.command(JSON.stringify({ cmd: "draft", key: "new", text: "half a sentence" }), () => undefined);
    await until(() => laptop.some((e) => e.ev === "drafts"));
    expect(laptop.find((e) => e.ev === "drafts")!.items).toMatchObject([{ key: "new", text: "half a sentence" }]);
    expect(phone.some((e) => e.ev === "drafts")).toBe(true);
    // A window that attaches later is not replayed drafts; it asks.
    const late: string[] = [];
    hub.attach({ send: (l) => { late.push(String(l)); } }, 0);
    expect(late.some((l) => l.includes('"ev":"drafts"'))).toBe(false);
    const answer: string[] = [];
    hub.command('{"cmd":"drafts"}', (r) => answer.push(r));
    expect(JSON.parse(answer[0]!).items[0].text).toBe("half a sentence");
    await hub.stop();
    const again = make();
    const back: string[] = [];
    again.command('{"cmd":"drafts"}', (r) => back.push(r));
    expect(JSON.parse(back[0]!).items[0].text).toBe("half a sentence");
    await again.stop();
  });
});

describe("deleting a conversation on a computer", () => {
  test("nothing of it is left: its record, saved session, checkpoints, what it wrote, its words in the search and the text typed for it", async () => {
    const { existsSync, mkdirSync, writeFileSync, readdirSync } = await import("node:fs");
    const { checkpointsDir, journalDir, sessionsDir } = await import("../src/config.ts");
    const state = tempDir(), work = tempDir(); dirs.push(state, work);
    const env = { HOME: state, XDG_STATE_HOME: state, XDG_CONFIG_HOME: state, NAVVIED_BASE_URL: mock.url, NAVVIED_MODEL: "mock-model", NAVVIED_WINDOW: "100000" };
    const hub = createHub({ json: false, yes: false, thinking: false, cwd: work } as never, fakeIO({ env }).io, { watch: false });
    const got: { ev: string; id?: string; items?: { id: string }[] }[] = [];
    hub.attach({ send: (l) => { got.push(JSON.parse(String(l))); } }, 0);
    const send = (cmd: object): void => hub.command(JSON.stringify(cmd), () => undefined);
    send({ cmd: "prompt", text: "a conversation to delete", qid: "q1" });
    await until(() => got.some((e) => e.ev === "done"));
    const id = got.find((e) => e.ev === "session")!.id!;
    // What a turn that changed files would have left, and text typed for it.
    mkdirSync(checkpointsDir(env), { recursive: true });
    writeFileSync(join(checkpointsDir(env), `${id}.json`), JSON.stringify({ version: 1, items: [] }));
    send({ cmd: "draft", key: id, text: "half typed" });
    expect(existsSync(join(journalDir(env), `${id}.json`))).toBe(true);
    send({ cmd: "new" });
    await until(() => got.filter((e) => e.ev === "session").length === 2);
    send({ cmd: "remove", id });
    await until(() => !existsSync(join(journalDir(env), `${id}.json`)));
    expect(existsSync(join(checkpointsDir(env), `${id}.json`))).toBe(false);
    expect(existsSync(join(sessionsDir(env), `${id}.json`))).toBe(false);
    expect(readdirSync(sessionsDir(env)).includes(`${id}.json`)).toBe(false);
    const answer: string[] = [];
    hub.command('{"cmd":"drafts"}', (r) => answer.push(r));
    expect(JSON.parse(answer[0]!).items.some((d: { key: string }) => d.key === id)).toBe(false);
    send({ cmd: "search", query: "conversation to delete" });
    await until(() => got.some((e) => e.ev === "found"));
    expect((got.find((e) => e.ev === "found") as unknown as { items: { id: string }[] }).items.some((h) => h.id === id)).toBe(false);
    await hub.stop();
  });
});
