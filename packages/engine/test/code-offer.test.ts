import { afterAll, describe, expect, test } from "bun:test";
import { CODE_AFTER, CodeOffer, asksForMany, codeNote } from "../src/code-offer.ts";
import { SMALL_WINDOW, defaultTools } from "../src/index.ts";
import type { Tool } from "../src/types.ts";
import { HOOK_MS, cleanupAll, prompt, rig } from "./helpers.ts";

afterAll(cleanupAll, HOOK_MS);

/** A connected program's tool: data moves through it, and it answers with `size` characters. */
const records = (size = 100): Tool => ({ name: "mcp__records__get", readOnly: true, description: "get", parameters: { type: "object", properties: { id: { type: "number" } } }, title: () => "get", run: async () => "x".repeat(size) });
const tools = (...extra: Tool[]) => ({ tools: [...defaultTools(), ...extra], toolOn: () => true });
const call = (id: number) => ({ name: "mcp__records__get", args: { id } });
const offered = (r: ReturnType<typeof rig>, i: number) => r.provider.requests[i]!.tools.map((t) => t.name).includes("ExecuteCode");
const lastTool = (r: ReturnType<typeof rig>, i: number) => { const m = r.provider.requests[i]!.messages.filter((x) => x.role === "tool"); return m[m.length - 1]!.content as string; };

describe("the counters", () => {
  test("only the data-moving kinds count, and the note comes once, at the sixth call", () => {
    const c = new CodeOffer();
    c.begin("look around");
    c.count("Bash", "x".repeat(50_000));
    expect(c.note()).toBeUndefined();
    expect(c.offered).toBe(false);
    for (let i = 1; i < CODE_AFTER.calls; i++) c.count("Read", "a");
    expect(c.offered).toBe(false);
    expect(c.note()).toBeUndefined();
    c.count("mcp__s__t", "a");
    expect(c.offered).toBe(true);
    expect(c.note()).toBe(codeNote(6, 6));
    c.count("Read", "a");
    expect(c.note()).toBeUndefined();
  });

  test("one big result is enough, and a new turn starts again", () => {
    const c = new CodeOffer();
    c.begin("x");
    c.count("WebFetch", "y".repeat(CODE_AFTER.chars));
    expect(c.note()).toContain("1 calls and 20,000 characters");
    c.begin("x");
    expect(c.offered).toBe(false);
    c.count("Grep", "y");
    expect(c.note()).toBeUndefined();
  });

  test("the limits can be set", () => {
    const c = new CodeOffer({ calls: 2, chars: 1e9 });
    c.begin("x");
    c.count("Read", "");
    expect(c.note()).toBeUndefined();
    c.count("Read", "");
    expect(c.note()).toBeDefined();
  });
});

describe("what a request says up front", () => {
  test.each([
    "for each of the 40 files in src/ add a header",
    "baca setiap 25 halaman di docs/ lalu rangkum",
    "为 30 个文件 逐个检查 *.ts",
    "check 12 pages: https://a.io/1 https://a.io/2 https://a.io/3",
    "update src/a.ts src/b.ts src/c.ts src/d.ts src/e.ts src/f.ts src/g.ts src/h.ts src/i.ts src/j.ts",
  ])("%s", (t) => expect(asksForMany(t)).toBe(true));

  test.each([
    "fix the failing test",
    "rename foo to bar in src/a.ts",
    "wait 30 seconds",
    "set the timeout to 30",
    "upgrade to v10.2 in 2026",
    "update every file in this folder",
    "at 10:30 look at src/a.ts",
    "read src/a.ts and src/b.ts and src/c.ts",
    "",
  ])("not: %s", (t) => expect(asksForMany(t)).toBe(false));
});

describe("the tool in the list of an engine that has it switched on", () => {
  test("a 2-call task never sees it, and its text costs nothing on the first request", async () => {
    const r = rig((_q, n) => (n < 2 ? { calls: [call(n)] } : { text: "ok" }), tools(records()));
    await r.turn(prompt("get two records"));
    for (let i = 0; i < r.provider.requests.length; i++) expect(offered(r, i)).toBe(false);
    expect(r.provider.requests[0]!.system).not.toContain("ExecuteCode");
    r.cleanup();
  });

  test("40 parallel calls bring the note at once and the tool on the next step, once", async () => {
    const r = rig((_q, n) => (n === 0 ? { calls: Array.from({ length: 40 }, (_, i) => call(i)) } : n === 1 ? { calls: [call(99)] } : { text: "ok" }), tools(records(10)));
    await r.turn(prompt("get the records"));
    expect(offered(r, 0)).toBe(false);
    expect(offered(r, 1)).toBe(true);
    expect(lastTool(r, 1)).toContain(codeNote(40, 400));
    expect(lastTool(r, 2)).not.toContain("ExecuteCode runs them");
    expect(r.provider.requests[1]!.messages.filter((m) => m.role === "tool" && (m.content as string).includes("ExecuteCode runs")).length).toBe(1);
    r.cleanup();
  });

  test("sequential calls reach the limit at the sixth; big results reach the other limit", async () => {
    const a = rig((_q, n) => (n < 8 ? { calls: [call(n)] } : { text: "ok" }), tools(records()));
    await a.turn(prompt("get records"));
    expect([0, 1, 2, 3, 4, 5, 6].map((i) => offered(a, i))).toEqual([false, false, false, false, false, false, true]);
    expect(lastTool(a, 6)).toContain("6 calls");
    a.cleanup();
    const b = rig((_q, n) => (n < 3 ? { calls: [call(n)] } : { text: "ok" }), tools(records(10_000)));
    await b.turn(prompt("get records"));
    expect([0, 1, 2, 3].map((i) => offered(b, i))).toEqual([false, false, true, true]);
    b.cleanup();
  });

  test("a request that says it up front has it from the first step, and no note is added", async () => {
    const r = rig((_q, n) => (n < 7 ? { calls: [call(n)] } : { text: "ok" }), tools(records()));
    await r.turn(prompt("for each of the 40 records in src/ get it"));
    expect(offered(r, 0)).toBe(true);
    expect(lastTool(r, 7)).not.toContain("ExecuteCode runs them");
    r.cleanup();
  });

  test("a model that used it keeps it; the next turn starts closed", async () => {
    const r = rig((_q, n) => (n === 0 ? { calls: Array.from({ length: 6 }, (_, i) => call(i)) } : { text: "ok" }), tools(records()));
    await r.turn(prompt("one"));
    expect(offered(r, 1)).toBe(true);
    await r.turn(prompt("two"));
    expect(offered(r, r.provider.requests.length - 1)).toBe(false);
    r.cleanup();
  });

  test("a small model never gets it, however much it reads", async () => {
    const r = rig((_q, n) => (n === 0 ? { calls: Array.from({ length: 12 }, (_, i) => call(i)) } : { text: "ok" }), { ...tools(records(10_000)), window: SMALL_WINDOW });
    await r.turn(prompt("for each of the 40 records get it"));
    for (let i = 0; i < r.provider.requests.length; i++) expect(offered(r, i)).toBe(false);
    r.cleanup();
  });

  test("with its switch off nothing is offered and no note is added", async () => {
    const r = rig((_q, n) => (n === 0 ? { calls: Array.from({ length: 12 }, (_, i) => call(i)) } : { text: "ok" }), { tools: [...defaultTools(), records()], toolOn: (n) => n !== "ExecuteCode" });
    await r.turn(prompt("get"));
    expect(offered(r, 1)).toBe(false);
    expect(lastTool(r, 1)).not.toContain("ExecuteCode");
    r.cleanup();
  });

  test("the always mode offers it from the first request", async () => {
    const r = rig(() => ({ text: "ok" }), { ...tools(), codeOffer: { mode: "always" } });
    await r.turn(prompt("hi"));
    expect(offered(r, 0)).toBe(true);
    r.cleanup();
  });
});
