import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHub } from "../src/commands/hub.ts";
import { journalDir } from "../src/config.ts";
import { SearchIndex, matchQuery } from "../src/search-index.ts";
import { fakeIO, remove, startMockModel, tempDir, until } from "./helpers.ts";

let mock: ReturnType<typeof startMockModel>;
const dirs: string[] = [];
beforeAll(() => { mock = startMockModel(); });
afterAll(() => { mock.stop(); dirs.forEach(remove); });

const say = (k: "user" | "assistant" | "tool", text: string) => ({ k, text });

describe("the words of a search", () => {
  test("every word must be there, the last may be a start, and nothing typed can break the query", () => {
    expect(matchQuery("Fix  the Build")).toBe('"fix" AND "the" AND "build"*');
    expect(matchQuery('weird" OR NEAR( * ) --')).toBe('"weird" AND "or" AND "near"*');
    expect(matchQuery("   ")).toBeUndefined();
    expect(matchQuery("日本語のテスト")).toBe('"日本語のテスト"*');
  });
});

describe("the search index for the agent", () => {
  test("each hit says which item matched, a loose search finds any word, recent lists the latest, and an index of an older shape is rebuilt", () => {
    const db = new SearchIndex(":memory:");
    db.put("a", "Tresor", 10, [say("user", "hallo"), say("tool", "Read"), say("assistant", "der Ersatzschluessel liegt im Tresor im Buero")]);
    db.put("b", "lain", 20, [say("user", "Rezept fuer Pfannkuchen")]);
    expect(db.search("tresor")[0]).toMatchObject({ id: "a", n: 3 });
    expect(db.search("tresor haus")).toEqual([]);
    expect(db.search("tresor haus", 5, true)[0]).toMatchObject({ id: "a", n: 3 });
    expect(db.recent(5).map((r) => r.id)).toEqual(["b", "a"]);
    expect(matchQuery("a b", true)).toBe('"a" OR "b"*');
  });
  test("a file made before the item number was kept is dropped and starts again", () => {
    const dir = tempDir();
    dirs.push(dir);
    const path = join(dir, "old.sqlite");
    const old = new Database(path, { create: true });
    old.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, updated INTEGER NOT NULL)");
    old.exec("CREATE VIRTUAL TABLE turns USING fts5(session UNINDEXED, text)");
    old.exec("INSERT INTO sessions VALUES ('x', 't', 1)");
    old.close();
    const db = new SearchIndex(path);
    expect(db.empty).toBe(true);
    db.put("x", "t", 1, [say("user", "hello world")]);
    expect(db.search("hello")[0]!.n).toBe(1);
    db.close();
  });
});

describe("the search index", () => {
  test("finds the conversations that mention the words, best first, once each, with the passage", () => {
    const db = new SearchIndex(":memory:");
    db.put("a", "database", 10, [say("user", "how do I migrate the postgres database schema?"), say("assistant", "use a migration tool for the postgres schema")]);
    db.put("b", "cooking", 20, [say("user", "a recipe for pancakes"), say("assistant", "flour, milk, eggs")]);
    db.put("c", "postgres tuning", 30, [say("user", "make postgres faster")]);
    const hits = db.search("postgres sch");
    expect(hits.map((h) => h.id)).toEqual(["a"]);
    expect(hits[0]!.snippet).toContain("[");
    expect(db.search("postgres").map((h) => h.id).sort()).toEqual(["a", "c"]);
    expect(db.search("pancakes")[0]).toMatchObject({ id: "b", title: "cooking", updated: 20 });
    expect(db.search("nothing here")).toEqual([]);
    expect(db.search("")).toEqual([]);
  });
  test("tool names are not searched, accents and other scripts are, and a conversation saved again replaces its old words", () => {
    const db = new SearchIndex(":memory:");
    db.put("a", "t", 1, [say("user", "café résumé"), say("tool", "ReadSecretTool")]);
    expect(db.search("cafe")).toHaveLength(1);
    expect(db.search("ReadSecretTool")).toEqual([]);
    db.put("a", "t", 2, [say("user", "completely different")]);
    expect(db.search("resume")).toEqual([]);
    expect(db.search("different")).toHaveLength(1);
    db.remove("a");
    expect(db.search("different")).toEqual([]);
    expect(db.empty).toBe(true);
  });
});

describe("searching from any window", () => {
  test("the first search reads the older conversations in, and a new conversation is searchable at once", async () => {
    const state = tempDir(), work = tempDir();
    dirs.push(state, work);
    const env = { HOME: state, XDG_STATE_HOME: state, NAVVIED_BASE_URL: mock.url, NAVVIED_MODEL: "mock-model", NAVVIED_WINDOW: "100000" };
    mkdirSync(journalDir(env), { recursive: true });
    writeFileSync(join(journalDir(env), "old.json"), JSON.stringify({ version: 1, items: [say("user", "explain the zebra crossing rules"), say("assistant", "cars stop")] }));
    const hub = createHub({ json: false, yes: false, thinking: false, cwd: work } as never, fakeIO({ env }).io, { watch: false });
    const got: { ev: string; [k: string]: unknown }[] = [];
    hub.attach({ send: (line) => { got.push(JSON.parse(String(line))); } }, 0);
    hub.command(JSON.stringify({ cmd: "search", query: "zebra" }), () => undefined);
    await until(() => got.some((e) => e.ev === "found"));
    expect((got.find((e) => e.ev === "found") as unknown as { items: { id: string }[] }).items.map((i) => i.id)).toEqual(["old"]);

    hub.command(JSON.stringify({ cmd: "prompt", text: "tell me about the giraffe", qid: "q1", mode: "auto" }), () => undefined);
    await until(() => got.some((e) => e.ev === "done"));
    hub.command(JSON.stringify({ cmd: "search", query: "giraffe" }), () => undefined);
    await until(() => got.filter((e) => e.ev === "found").length === 2);
    expect((got.filter((e) => e.ev === "found")[1] as unknown as { items: { snippet: string }[] }).items[0]!.snippet).toContain("giraffe");
    await hub.stop();
  });
});
