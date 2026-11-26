import { afterAll, describe, expect, test } from "bun:test";
import { EmbeddingError, embed, memoryText, type EmbeddingConfig } from "@navvied/engine";
import { Meaning, notesByMeaning, withMeaning } from "../src/meaning.ts";
import { embeddingConfig, parseEmbeddings } from "../src/meaning-config.ts";
import { SearchIndex } from "../src/search-index.ts";
import { MEMORY_FILE } from "@navvied/engine";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { remove } from "./helpers.ts";

/** Words that mean the same thing share a direction, as a real model's vectors do; every other word is a little noise in a corner of its own. */
const CONCEPTS: Record<string, number> = {
  date: 0, dates: 0, format: 0, formatted: 0, timestamp: 0, timestamps: 0, iso: 0, "8601": 0, datum: 0,
  tabs: 1, indent: 1, indentation: 1, whitespace: 1, spaces: 1,
  deploy: 2, release: 2, ship: 2, publish: 2,
  test: 3, tests: 3, verify: 3, check: 3,
};
const DIM = 8;
function vectorOf(text: string): number[] {
  const v = new Array<number>(DIM).fill(0);
  for (const w of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    const c = CONCEPTS[w];
    if (c !== undefined) v[c]! += 1;
    else v[4 + (Bun.hash(w) % 4n === 0n ? 0 : Number(Bun.hash(w) % 4n))]! += 0.05;
  }
  return v;
}

interface Seen { path: string; auth: string | undefined; body: { model: string; input: string[] } }
/** A server on localhost that answers like an embeddings server; `mode` makes it fail, and `dim` changes the size of what it answers. */
function fakeServer(options: { mode?: "ok" | "status" | "garbage" | "short"; dim?: number } = {}) {
  const seen: Seen[] = [];
  const state = { mode: options.mode ?? "ok", dim: options.dim ?? DIM };
  const widen = (v: number[]): number[] => (state.dim === DIM ? v : [...v, ...new Array<number>(state.dim - DIM).fill(0.5)].slice(0, state.dim));
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      const body = (await req.json()) as Seen["body"];
      seen.push({ path, auth: req.headers.get("authorization") ?? undefined, body });
      if (state.mode === "status") return new Response("nope", { status: 500 });
      if (state.mode === "garbage") return Response.json({ unexpected: true });
      const vectors = body.input.map((t) => widen(vectorOf(t)));
      if (state.mode === "short") return Response.json({ data: [{ index: 0, embedding: vectors[0] }] });
      if (path === "/api/embed") return Response.json({ embeddings: vectors });
      if (path === "/v1/embeddings") return Response.json({ data: vectors.map((embedding, index) => ({ index, embedding })).reverse() });
      return new Response("not found", { status: 404 });
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  return { seen, state, base, stop: () => server.stop(true), chat: (extra: Partial<EmbeddingConfig> = {}): EmbeddingConfig => ({ baseUrl: `${base}/v1`, model: "fake-1", api: "chat", ...extra }), ollama: (extra: Partial<EmbeddingConfig> = {}): EmbeddingConfig => ({ baseUrl: base, model: "fake-1", api: "ollama", ...extra }) };
}

const servers: ReturnType<typeof fakeServer>[] = [];
const dirs: string[] = [];
const serve = (o?: Parameters<typeof fakeServer>[0]) => { const s = fakeServer(o); servers.push(s); return s; };
afterAll(() => { servers.forEach((s) => s.stop()); dirs.forEach(remove); });

const NOTES = ["We use ISO 8601 for timestamps", "Always use tabs for indentation", "Deploys go out on Fridays", "The build needs bun"];

describe("the embeddings call, in each shape", () => {
  test("chat shape: posts to /embeddings with the model and the key, and puts the vectors in order by index", async () => {
    const s = serve();
    const out = await embed(s.chat({ apiKey: "k-test-123" }), ["dates", "tabs"]);
    expect(s.seen[0]).toMatchObject({ path: "/v1/embeddings", auth: "Bearer k-test-123", body: { model: "fake-1", input: ["dates", "tabs"] } });
    expect(out).toHaveLength(2);
    expect(out[0]![0]).toBeGreaterThan(0.9);
    expect(out[1]![1]).toBeGreaterThan(0.9);
    expect(Math.hypot(...out[0]!)).toBeCloseTo(1, 5);
  });
  test("Ollama shape: posts to /api/embed and reads `embeddings`; no key means no authorization header", async () => {
    const s = serve();
    const out = await embed(s.ollama(), ["deploy"]);
    expect(s.seen[0]).toMatchObject({ path: "/api/embed", auth: undefined });
    expect(out[0]![2]).toBeGreaterThan(0.9);
  });
  test("a server that fails, answers something else, or answers too few vectors gives a plain reason, never the key", async () => {
    for (const [mode, words] of [["status", "status 500"], ["garbage", "not understood"], ["short", "not understood"]] as const) {
      const s = serve({ mode });
      const error = await embed(s.chat({ apiKey: "k-secret-999" }), ["a", "b"]).catch((e) => e);
      expect(error).toBeInstanceOf(EmbeddingError);
      expect(error.message).toContain(words);
      expect(error.message).not.toContain("k-secret-999");
    }
    const down = await embed({ baseUrl: "http://127.0.0.1:9/v1", model: "m", api: "chat", apiKey: "k-secret-999" }, ["a"]).catch((e) => e);
    expect(down.message).toBe("the embeddings server could not be reached");
    const aborted = await embed(serve().chat(), ["a"], AbortSignal.abort()).catch((e) => e);
    expect(aborted.message).toBe("the embeddings server did not answer in time");
  });
  test("secrets are hidden before anything is sent, and a long text is cut", async () => {
    const s = serve();
    await embed(s.chat(), ["use sk-abcdefghijklmnopqrstuvwxyz0123 for it", "my password is Zx9!kQ7mPw today", `long ${"word ".repeat(1_000)}`]);
    const sent = s.seen[0]!.body.input;
    expect(sent[0]).not.toContain("sk-abcdefgh");
    expect(sent[1]).not.toContain("Zx9!kQ7mPw");
    expect(sent[2]!.length).toBeLessThanOrEqual(1_500);
  });
  test("a long list is sent in batches", async () => {
    const s = serve();
    await embed(s.chat(), Array.from({ length: 70 }, (_, i) => `text ${i}`));
    expect(s.seen.map((r) => r.body.input.length)).toEqual([32, 32, 6]);
  });
});

describe("notes by meaning", () => {
  test("a question in other words ranks the note that means it first, and the vectors are kept and not made again", async () => {
    const s = serve();
    const m = new Meaning(s.chat(), ":memory:");
    const like = await m.notes("how should dates be formatted", NOTES);
    expect([...like].sort((a, b) => b[1] - a[1])[0]![0]).toBe("We use ISO 8601 for timestamps");
    const first = s.seen.length;
    await m.notes("which release day", NOTES);
    expect(s.seen.slice(first).flatMap((r) => r.body.input)).toEqual(["which release day"]);
    expect(m.notice()).toBeUndefined();
  });
  test("with the words and the meaning fused, the note that means it is in front of the model though no word is shared", async () => {
    const s = serve();
    const dir = mkdtempSync(join(tmpdir(), "navvied-meaning-")); dirs.push(dir);
    mkdirSync(join(dir, "p"), { recursive: true });
    const project = join(dir, "p", MEMORY_FILE);
    const all = [NOTES[0]!, "Lunch is at noon", "Parking is behind the shed", "The cat is called Miso", "Coffee is on the second floor", "Fridays are quiet", "Badges are blue"];
    writeFileSync(project, all.map((t, i) => `- 2026-01-0${i + 1}: ${t}`).join("\n"));
    const paths = { user: join(dir, "u.md"), project };
    const by = notesByMeaning(new Meaning(s.ollama(), ":memory:"), () => all);
    expect(memoryText(paths, "how should dates be formatted")).not.toContain("ISO");
    await by.prepare({ userText: "how should dates be formatted" });
    expect(memoryText(paths, "how should dates be formatted", by.like())).toContain("ISO 8601");
  });
  test("asked once for each thing the person writes, not at every step", async () => {
    const s = serve();
    const by = notesByMeaning(new Meaning(s.chat(), ":memory:"), () => NOTES);
    await by.prepare({ userText: "dates" });
    const n = s.seen.length;
    await by.prepare({ userText: "dates" });
    expect(s.seen.length).toBe(n);
    await by.prepare({ userText: "tabs" });
    expect(s.seen.length).toBe(n + 1);
  });
  test("a server that fails gives no likeness and one plain line; the next success clears it", async () => {
    const s = serve({ mode: "status" });
    const m = new Meaning(s.chat({ apiKey: "k-secret-999" }), ":memory:");
    expect((await m.notes("dates", NOTES)).size).toBe(0);
    expect(m.notice()).toBe("Search by meaning is off right now (the embeddings server answered with status 500); these results are by words.");
    expect(m.notice()).not.toContain("k-secret-999");
    s.state.mode = "ok";
    expect((await m.notes("dates", NOTES)).size).toBe(NOTES.length);
    expect(m.notice()).toBeUndefined();
  });
  test("a model that was changed: vectors of another model, or of another size, are made again", async () => {
    const s = serve();
    const path = join(mkdtempSync(join(tmpdir(), "navvied-meaning-")), "v.sqlite"); dirs.push(join(path, ".."));
    const opened: Meaning[] = [];
    const meaning = (model?: string): Meaning => { const made = new Meaning(s.chat(model ? { model } : {}), path); opened.push(made); return made; };
    await meaning().notes("dates", NOTES);
    const before = s.seen.length;
    await meaning("fake-2").notes("dates", NOTES);
    expect(s.seen.slice(before).flatMap((r) => r.body.input)).toEqual(["dates", ...NOTES]);
    s.state.dim = 12;
    const again = meaning("fake-2");
    const like = await again.notes("dates", NOTES);
    expect(like.size).toBe(0);
    const made = s.seen.length;
    expect((await again.notes("dates", NOTES)).size).toBe(NOTES.length);
    expect(s.seen.slice(made).flatMap((r) => r.body.input)).toEqual(["dates", ...NOTES]);
    for (const one of opened) one.close();
  });
});

describe("earlier conversations by meaning", () => {
  const say = (k: "user" | "assistant", text: string) => ({ k, text });
  function seeded() {
    const db = new SearchIndex(":memory:");
    const a = [say("user", "which format for timestamps"), say("assistant", "We agreed on ISO 8601 timestamps everywhere")];
    const b = [say("user", "please indent with tabs"), say("assistant", "Done, tabs it is")];
    db.put("dates", "Timestamps", 10, a);
    db.put("tabs", "Indentation", 20, b);
    return { db, a, b };
  }
  test("a question with no word in common finds the conversation by meaning; the words alone find nothing", async () => {
    const s = serve();
    const { db } = seeded();
    const m = new Meaning(s.chat(), ":memory:");
    expect(db.search("how should dates be formatted")).toEqual([]);
    const hits = await withMeaning(db, m, "how should dates be formatted", [], 5);
    expect(hits[0]).toMatchObject({ id: "dates" });
    expect(hits.map((h) => h.id)).not.toContain("tabs");
    expect(hits[0]!.snippet.length).toBeGreaterThan(0);
  });
  test("a conversation that both the words and the meaning like comes first", async () => {
    const s = serve();
    const { db } = seeded();
    const m = new Meaning(s.ollama(), ":memory:");
    const byWords = db.search("timestamps");
    const hits = await withMeaning(db, m, "timestamps", byWords, 5);
    expect(hits[0]!.id).toBe("dates");
  });
  test("a new turn gives vectors to the new messages only, and a shorter history drops the rest", async () => {
    const s = serve();
    const { a } = seeded();
    const m = new Meaning(s.chat(), ":memory:");
    expect(await m.index("dates", a)).toBe(2);
    expect(await m.index("dates", a)).toBe(0);
    expect(await m.index("dates", [...a, say("user", "and what about dates in logs")])).toBe(1);
    expect(await m.index("dates", [a[0]!])).toBe(0);
    expect(await m.rank("ISO 8601 timestamps", 5)).toMatchObject([{ id: "dates", n: 1 }]);
  });
  test("history from before the server was set up is caught up with, a limited number at a time", async () => {
    const s = serve();
    const { db } = seeded();
    const m = new Meaning(s.chat(), ":memory:");
    expect(await m.catchUp(db.newest(100))).toBe(4);
    expect(await m.catchUp(db.newest(100))).toBe(0);
  });
  test("a server that is down leaves the words alone, and the notice says why", async () => {
    const s = serve({ mode: "status" });
    const { db } = seeded();
    const m = new Meaning(s.chat(), ":memory:");
    const byWords = db.search("timestamps");
    expect(await withMeaning(db, m, "timestamps", byWords, 5)).toEqual(byWords);
    expect(m.notice()).toContain("status 500");
  });
});

describe("the setting", () => {
  test("it is read and checked; the key may be named by an environment variable; an error never repeats the key", () => {
    expect(parseEmbeddings({ baseUrl: "http://127.0.0.1:8080/v1", model: "nomic", api: "chat", apiKeyEnv: "EMB_KEY" })).toEqual({ baseUrl: "http://127.0.0.1:8080/v1", model: "nomic", api: "chat", apiKeyEnv: "EMB_KEY" });
    expect(parseEmbeddings({ baseUrl: "http://example.test/v1", model: "m", api: "chat", apiKey: "k-secret-999" })).toBe(`"memory.embeddings.baseUrl" must be an https address, or http on this computer`);
    expect(parseEmbeddings({ baseUrl: "https://example.test/v1", model: "m", api: "other", apiKey: "k-secret-999" })).toBe(`"memory.embeddings.api" must be "chat" or "ollama"`);
    expect(parseEmbeddings({ baseUrl: "https://example.test/v1", api: "ollama" })).toContain("model");
    expect(parseEmbeddings("x")).toContain("object");
    expect(embeddingConfig({ baseUrl: "https://e.test", model: "m", api: "chat", apiKey: "a", apiKeyEnv: "K" }, { K: "from-env" })?.apiKey).toBe("from-env");
    expect(embeddingConfig(undefined, {})).toBeUndefined();
  });
});
