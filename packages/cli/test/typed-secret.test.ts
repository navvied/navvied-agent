import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { journalDir } from "../src/config.ts";
import { createHub } from "../src/commands/hub.ts";
import { transcriptOf } from "../src/handover.ts";
import { Journal, titleOf } from "../src/journal.ts";
import { Meaning } from "../src/meaning.ts";
import { SearchIndex } from "../src/search-index.ts";
import { fakeIO, remove, startMockModel, tempDir, until } from "./helpers.ts";

const PASSWORD = "Zx9!kQ7mWp2";
const SAID = `my password is ${PASSWORD}, log in with it`;
const ITEMS = [{ k: "user" as const, text: SAID }, { k: "assistant" as const, text: `Logged in with ${PASSWORD}.` }];

let mock: ReturnType<typeof startMockModel>;
const dirs: string[] = [];
beforeAll(() => { mock = startMockModel(); });
afterAll(() => { mock.stop(); dirs.forEach(remove); });

describe("a password the person typed stays in their journal and goes nowhere else", () => {
  test("the journal keeps it, in a file only its owner reads", () => {
    const dir = tempDir(); dirs.push(dir);
    const journal = new Journal(dir);
    journal.write("c1", ITEMS);
    expect(journal.items("c1")![0]!.text).toContain(PASSWORD);
    expect(statSync(join(dir, "c1.json")).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  test("a copy of a conversation (a fork) and its title do not hold it", () => {
    const dir = tempDir(); dirs.push(dir);
    const journal = new Journal(dir);
    journal.write("c1", ITEMS);
    expect(journal.copy("c1", "c2")).toBe(true);
    expect(readFileSync(join(dir, "c2.json"), "utf8")).not.toContain(PASSWORD);
    expect(titleOf(ITEMS)).not.toContain(PASSWORD);
    expect(statSync(join(dir, "c2.json")).mode & 0o777).toBe(0o600);
  });

  test("the search index does not find it, and holds it nowhere in its rows", () => {
    const db = new SearchIndex(":memory:");
    db.put("c1", titleOf(ITEMS), 1, ITEMS);
    expect(db.search("Zx9", 5)).toEqual([]);
    expect(db.search(PASSWORD, 5, true)).toEqual([]);
    expect(db.search("logged", 5).length).toBe(1);
  });

  test("the meaning index sends it to no embeddings server", async () => {
    const bodies: string[] = [];
    const server = Bun.serve({ port: 0, async fetch(req) { const body = await req.json() as { input: string[] }; bodies.push(...body.input); return Response.json({ data: body.input.map((_, index) => ({ index, embedding: [1, 0, 0] })) }); } });
    try {
      const m = new Meaning({ baseUrl: `http://127.0.0.1:${server.port}`, api: "chat", model: "m" } as never, ":memory:");
      await m.index("c1", ITEMS);
      expect(bodies.length).toBe(2);
      expect(bodies.join("\n")).not.toContain(PASSWORD);
    } finally { server.stop(true); }
  });

  test("a conversation handed to another model does not carry it", () => {
    expect(transcriptOf(ITEMS)).not.toContain(PASSWORD);
    expect(transcriptOf(ITEMS)).toContain("Logged in with");
  });

  test("a window reached through the relay is not sent it, live or in a replay; a window on this computer is", async () => {
    const state = tempDir(), work = tempDir();
    dirs.push(state, work);
    const env = { HOME: state, XDG_STATE_HOME: state, NAVVIED_BASE_URL: mock.url, NAVVIED_MODEL: "mock-model", NAVVIED_WINDOW: "100000" };
    const hub = createHub({ json: false, yes: false, thinking: false, cwd: work } as never, fakeIO({ env }).io, { watch: false });
    const local: string[] = [], remote: string[] = [];
    hub.attach({ send: (line) => { local.push(String(line)); } }, 0);
    hub.attach({ leaves: true, send: (line) => { remote.push(String(line)); } }, 0);
    hub.command(JSON.stringify({ cmd: "prompt", text: SAID, qid: "q1", mode: "auto" }), () => undefined);
    await until(() => local.some((l) => l.includes('"ev":"done"')));
    expect(local.join("\n")).toContain(PASSWORD);
    expect(remote.join("\n")).not.toContain(PASSWORD);
    expect(remote.some((l) => l.includes('"ev":"user"'))).toBe(true);
    const replay: string[] = [];
    hub.attach({ leaves: true, send: (line) => { replay.push(String(line)); } }, 0);
    hub.attach({ leaves: true, send: (line) => { replay.push(String(line)); } }, 1);
    expect(replay.some((l) => l.includes('"ev":"user"'))).toBe(true);
    expect(replay.join("\n")).not.toContain(PASSWORD);
    const kept = readdirSync(journalDir(env)).filter((n) => n.endsWith(".json"));
    expect(readFileSync(join(journalDir(env), kept[0]!), "utf8")).toContain(PASSWORD);
    await hub.stop();
  });
});
