import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Journal, withQids } from "../src/journal.ts";
import { createHub } from "../src/commands/hub.ts";
import { fakeIO, remove, startMockModel, tempDir, until } from "./helpers.ts";

let mock: ReturnType<typeof startMockModel>;
const dirs: string[] = [];
beforeAll(() => { mock = startMockModel(); });
afterAll(() => { mock.stop(); dirs.forEach(remove); });

describe("what the journal keeps of what the person said", () => {
  test("a message keeps the id it was sent with, an answer and a tool have none, and an id that is not safe to keep is left out", () => {
    const dir = tempDir();
    dirs.push(dir);
    const j = new Journal(dir);
    j.record({ ev: "session", id: "s1" } as never);
    j.record({ ev: "user", qid: "q1", text: "first" });
    j.record({ ev: "text", text: "an answer" });
    j.record({ ev: "user", qid: "../x", text: "second" });
    j.record({ ev: "done", stop: "end_turn" });
    expect(j.items("s1")).toEqual([{ k: "user", text: "first", qid: "q1" }, { k: "assistant", text: "an answer" }, { k: "user", text: "second" }]);
  });
});

describe("ids put on a conversation that came without them", () => {
  test("by order and words: the same words said twice get their own ids, and a message the journal lacks stays as it is", () => {
    const kept = [{ k: "user" as const, text: "same", qid: "a" }, { k: "assistant" as const, text: "ok" }, { k: "user" as const, text: "same", qid: "b" }];
    const came = [{ k: "user" as const, text: "same" }, { k: "assistant" as const, text: "ok" }, { k: "user" as const, text: "same" }, { k: "user" as const, text: "new" }];
    expect(withQids(came, kept).map((i) => i.qid)).toEqual(["a", undefined, "b", undefined]);
    expect(withQids(came, undefined)).toEqual(came);
  });
});

describe("a conversation opened again", () => {
  test("says which message is which, so a window that already has one does not add it twice", async () => {
    const state = tempDir(), work = tempDir();
    dirs.push(state, work);
    const env = { HOME: state, XDG_STATE_HOME: state, XDG_CONFIG_HOME: state, NAVVIED_BASE_URL: mock.url, NAVVIED_MODEL: "mock-model", NAVVIED_WINDOW: "100000" };
    const hub = createHub({ json: false, yes: false, thinking: false, cwd: work } as never, fakeIO({ env }).io, { watch: false });
    const got: { ev: string; id?: string; items?: { k: string; text: string; qid?: string }[] }[] = [];
    hub.attach({ send: (line) => { got.push(JSON.parse(String(line))); } }, 0);
    hub.command(JSON.stringify({ cmd: "prompt", text: "hello there", qid: "q7" }), () => undefined);
    await until(() => got.some((e) => e.ev === "done"));
    const id = got.find((e) => e.ev === "session")!.id!;
    hub.command(JSON.stringify({ cmd: "load", id }), () => undefined);
    await until(() => got.some((e) => e.ev === "loaded"));
    expect(got.find((e) => e.ev === "loaded")!.items![0]).toEqual({ k: "user", text: "hello there", qid: "q7" });
    await hub.stop();
  });
});
