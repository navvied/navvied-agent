import { describe, expect, test } from "bun:test";
import { FallbackProvider, ProviderError, worthAnother } from "../src/index.ts";
import type { ModelReply, Provider, StreamHandlers } from "../src/index.ts";

const on: StreamHandlers = { text() {}, thought() {}, toolStarted() {} };
const req = { system: "s", messages: [], tools: [] };
const ok = (text: string): Provider => ({ async stream(_r, _s, h) { h.text(text); return { content: text, calls: [], finish: "stop" } as ModelReply; }, async complete() { return text; } });
const down = (status?: number): Provider => ({ async stream() { throw new ProviderError("nope", status); }, async complete() { throw new ProviderError("nope", status); } });

describe("which failures are worth another model", () => {
  test("an unreachable or overloaded model is, a wrong key or a bad request is not", () => {
    expect(worthAnother(new ProviderError("x"))).toBe(true);
    for (const s of [408, 429, 500, 502, 503]) expect(worthAnother(new ProviderError("x", s))).toBe(true);
    for (const s of [400, 401, 403, 404]) expect(worthAnother(new ProviderError("x", s))).toBe(false);
    expect(worthAnother(new TypeError("fetch failed"))).toBe(true);
    expect(worthAnother(new Error("something in our own code"))).toBe(false);
  });
});

describe("a chain of models", () => {
  test("the next one answers when the first cannot be reached, and the person is told once", async () => {
    const told: string[] = [];
    const chain = new FallbackProvider([{ name: "Main", provider: down(503) }, { name: "Backup", provider: ok("from backup") }], (m) => told.push(m));
    expect((await chain.stream(req, new AbortController().signal, on)).content).toBe("from backup");
    expect(told).toHaveLength(1);
    expect(told[0]).toContain("Main");
    expect(told[0]).toContain("Backup");
    expect(await chain.complete("s", "u", new AbortController().signal)).toBe("from backup");
  });
  test("a wrong key is reported as it is, not hidden by another model", async () => {
    const chain = new FallbackProvider([{ name: "Main", provider: down(401) }, { name: "Backup", provider: ok("x") }]);
    await expect(chain.stream(req, new AbortController().signal, on)).rejects.toThrow("nope");
  });
  test("a model that failed after it started answering is not replaced halfway", async () => {
    const halfway: Provider = { async stream(_r, _s, h) { h.text("par"); throw new ProviderError("cut", 502); }, async complete() { return ""; } };
    const chain = new FallbackProvider([{ name: "Main", provider: halfway }, { name: "Backup", provider: ok("whole") }]);
    await expect(chain.stream(req, new AbortController().signal, on)).rejects.toThrow("cut");
  });
  test("when every model fails the last failure is shown, and a cancel stops the chain", async () => {
    const all = new FallbackProvider([{ name: "A", provider: down(500) }, { name: "B", provider: down(502) }]);
    await expect(all.stream(req, new AbortController().signal, on)).rejects.toThrow("nope");
    const stop = new AbortController(); stop.abort();
    const cancelled = new FallbackProvider([{ name: "A", provider: down(500) }, { name: "B", provider: ok("x") }]);
    await expect(cancelled.stream(req, stop.signal, on)).rejects.toThrow("nope");
  });
});
