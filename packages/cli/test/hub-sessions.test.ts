import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chatFilesDir, chatJournalDir, journalDir } from "../src/config.ts";
import { createHub } from "../src/commands/hub.ts";
import { main } from "../src/main.ts";
import { fakeIO, remove, startMockModel, tempDir, until } from "./helpers.ts";

let mock: ReturnType<typeof startMockModel>;
const dirs: string[] = [];
beforeAll(() => { mock = startMockModel(); });
afterAll(() => { mock.stop(); dirs.forEach(remove); });

describe("a conversation that was only watched", () => {
  test("an engine that keeps its own sessions can continue it: what was said is handed over, and every window is shown it", async () => {
    const state = tempDir(), work = tempDir();
    dirs.push(state, work);
    const env = { HOME: state, XDG_STATE_HOME: state, NAVVIED_BASE_URL: mock.url, NAVVIED_MODEL: "mock-model", NAVVIED_WINDOW: "100000" };
    mkdirSync(journalDir(env), { recursive: true });
    writeFileSync(join(journalDir(env), "old-chat.json"), JSON.stringify({ version: 1, items: [{ k: "user", text: "remember the alpha topic" }, { k: "assistant", text: "noted" }, { k: "tool", text: "Read" }] }));
    const hub = createHub({ json: false, yes: false, thinking: false, cwd: work } as never, fakeIO({ env }).io, { watch: false });
    const got: { ev: string; [k: string]: unknown }[] = [];
    hub.attach({ send: (line) => { got.push(JSON.parse(String(line))); } }, 0);

    hub.command(JSON.stringify({ cmd: "sessions" }), () => undefined);
    await until(() => got.some((e) => e.ev === "sessions"));
    expect((got.find((e) => e.ev === "sessions") as unknown as { items: { id: string; title: string }[] }).items[0]).toMatchObject({ id: "old-chat", title: "remember the alpha topic" });

    hub.command(JSON.stringify({ cmd: "load", id: "old-chat" }), () => undefined);
    await until(() => got.some((e) => e.ev === "loaded" || e.ev === "error"));
    expect(got.some((e) => e.ev === "error")).toBe(false);
    const loaded = got.find((e) => e.ev === "loaded") as unknown as { id: string; items: { k: string; text: string }[] };
    expect(loaded.id).toBe("old-chat");
    expect(loaded.items.map((i) => i.k)).toEqual(["user", "assistant"]);
    await hub.stop();
  });
});

describe("serve --stdio, as a hosted session runs it", () => {
  test("what is said is written down in the state folder, for the host to keep afterwards", async () => {
    const state = tempDir(), work = tempDir();
    dirs.push(state, work);
    const env = { HOME: state, XDG_STATE_HOME: state, NAVVIED_BASE_URL: mock.url, NAVVIED_MODEL: "mock-model", NAVVIED_WINDOW: "100000" };
    const f = fakeIO({ env });
    const done = main(["serve", "--stdio", "--cwd", work], f.io);
    f.input.push(`${JSON.stringify({ cmd: "prompt", text: "remember the alpha topic", qid: "q1", mode: "auto" })}\n`);
    await until(() => f.out().includes('"ev":"done"'));
    f.input.end();
    await done;
    const files = readdirSync(journalDir(env)).filter((n) => n.endsWith(".json"));
    expect(files).toHaveLength(1);
    const saved = JSON.parse(readFileSync(join(journalDir(env), files[0]!), "utf8")) as { items: { k: string; text: string }[] };
    expect(saved.items[0]).toEqual({ k: "user", text: "remember the alpha topic" });
    expect(saved.items.some((i) => i.k === "assistant")).toBe(true);
  });
  test("one session holds an agent and a chat: each is written down apart, and a chat in a sandbox is offered commands", async () => {
    const state = tempDir(), work = tempDir();
    dirs.push(state, work);
    const env = { HOME: state, XDG_STATE_HOME: state, NAVVIED_BASE_URL: mock.url, NAVVIED_MODEL: "mock-model", NAVVIED_WINDOW: "100000" };
    const f = fakeIO({ env });
    const done = main(["serve", "--stdio", "--sandboxed", "--cwd", work], f.io);
    f.input.push(`${JSON.stringify({ cmd: "prompt", text: "plan a trip to Bali", qid: "c1", kind: "chat" })}\n`);
    await until(() => /"ev":"done"[^\n]*"kind":"chat"/.test(f.out()));
    f.input.push(`${JSON.stringify({ cmd: "prompt", text: "fix the beta bug", qid: "a1" })}\n`);
    await until(() => f.out().split("\n").some((l) => l.includes('"ev":"done"') && !l.includes('"kind"')));
    f.input.end();
    await done;
    const titleIn = (dir: string): string => (JSON.parse(readFileSync(join(dir, readdirSync(dir).filter((n) => n.endsWith(".json"))[0]!), "utf8")) as { items: { text: string }[] }).items[0]!.text;
    expect(readdirSync(journalDir(env)).filter((n) => n.endsWith(".json"))).toHaveLength(1);
    expect(readdirSync(chatJournalDir(env)).filter((n) => n.endsWith(".json"))).toHaveLength(1);
    expect(titleIn(journalDir(env))).toBe("fix the beta bug");
    expect(titleIn(chatJournalDir(env))).toBe("plan a trip to Bali");
    expect(chatFilesDir(env)).not.toBe(work);
    const caps = f.out().split("\n").filter((l) => l.includes('"ev":"caps"')).map((l) => JSON.parse(l) as { kind?: string; modes: string[] });
    expect(caps.find((c) => c.kind === "chat")!.modes).toEqual([]);
    expect(caps.find((c) => c.kind === undefined)!.modes).toEqual(["ask", "edits", "plan", "auto", "bypass"]);
  });
});
