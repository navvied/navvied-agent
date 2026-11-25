import { afterAll, describe, expect, test } from "bun:test";
import { FallbackProvider, MAX_ATTEMPTS, MOST_WAIT_MS, RetryProvider, retryable } from "../src/index.ts";
import { ChatCompletionsProvider, ProviderError } from "../src/providers/chat-completions.ts";
import type { ModelReply, ModelRequest, Provider, RetryInfo, StreamHandlers } from "../src/types.ts";
import { HOOK_MS, cleanupAll, prompt, rig } from "./helpers.ts";

afterAll(cleanupAll, HOOK_MS);

const req: ModelRequest = { system: "s", messages: [], tools: [] };
const reply = (content: string): ModelReply => ({ content, calls: [], finish: "stop", usage: { prompt: 1, completion: 1 } });
const noop = { text() {}, thought() {}, toolStarted() {} };

/** Fails with each of `errors` in turn, then answers. */
function flaky(errors: unknown[], answer = "ok"): Provider & { calls: number } {
  const p = {
    calls: 0,
    async stream(_r: ModelRequest, _s: AbortSignal, on: StreamHandlers) { const e = errors[p.calls++]; if (e) throw e; on.text(answer); return reply(answer); },
    async complete() { const e = errors[p.calls++]; if (e) throw e; return answer; },
  };
  return p;
}
const waits: number[] = [];
const options = { sleep: async (ms: number) => { waits.push(ms); }, random: () => 0.5 };
const status = (n: number, retryAfterMs?: number) => new ProviderError(`answered ${n}`, n, retryAfterMs);
const heard = (): { infos: RetryInfo[]; on: StreamHandlers } => { const infos: RetryInfo[] = []; return { infos, on: { ...noop, retry: (i) => infos.push(i) } }; };
const signal = (): AbortSignal => new AbortController().signal;

describe("which failures are worth another try", () => {
  test("busy, slow down, broken, too slow and a dropped connection are; a wrong request, a wrong key and an empty answer are not", () => {
    for (const s of [408, 429, 500, 502, 503, 529]) expect(retryable(status(s))).toBe(true);
    for (const s of [400, 401, 403, 404, 422]) expect(retryable(status(s))).toBe(false);
    expect(retryable(new TypeError("fetch failed"))).toBe(true);
    expect(retryable(new Error("read ECONNRESET"))).toBe(true);
    expect(retryable(new Error("connect ECONNREFUSED 127.0.0.1:11434"))).toBe(false);
    expect(retryable(new Error("getaddrinfo ENOTFOUND models.invalid"))).toBe(false);
    expect(retryable(new ProviderError("the model returned an empty answer"))).toBe(false);
    expect(retryable(new ProviderError("the model did not start answering within 180 seconds."))).toBe(false);
  });
});

describe("the one loop that makes a call to the model again", () => {
  test("a call that is refused as too busy is made again after a wait that grows, and each wait is announced first", async () => {
    waits.length = 0;
    const inner = flaky([status(429), status(529), status(503)]);
    const { infos, on } = heard();
    expect((await new RetryProvider(inner, options).stream(req, signal(), on)).content).toBe("ok");
    expect(inner.calls).toBe(4);
    expect(waits).toEqual([1000, 2000, 4000]);
    expect(infos).toEqual([
      { reason: "the model asked to slow down", attempt: 2, of: MAX_ATTEMPTS, inSeconds: 1 },
      { reason: "the model is busy", attempt: 3, of: MAX_ATTEMPTS, inSeconds: 2 },
      { reason: "the model is busy", attempt: 4, of: MAX_ATTEMPTS, inSeconds: 4 },
    ]);
  });

  test("the service's own Retry-After is obeyed, whatever the doubling would have been", async () => {
    waits.length = 0;
    const { infos, on } = heard();
    await new RetryProvider(flaky([status(429, 7000), status(429, 0)]), options).stream(req, signal(), on);
    expect(waits).toEqual([7000, 0]);
    expect(infos.map((i) => i.inSeconds)).toEqual([7, 1]);
  });

  test("a wrong request or a wrong key is reported at once, with no try and no event", async () => {
    for (const e of [status(400), status(401), new ProviderError("the model returned an empty answer")]) {
      waits.length = 0;
      const inner = flaky([e]);
      const { infos, on } = heard();
      await expect(new RetryProvider(inner, options).stream(req, signal(), on)).rejects.toBe(e);
      expect(inner.calls).toBe(1);
      expect(waits).toEqual([]);
      expect(infos).toEqual([]);
    }
  });

  test("a model server nobody is listening on, or a name that is not known, is one call and one plain sentence with the address: no wait, no retry event", async () => {
    for (const [base, message] of [["http://127.0.0.1:1/v1", "Nothing answers at http://127.0.0.1:1. Start the model server, then send again."], ["http://no-such-host.invalid/v1", "The address http://no-such-host.invalid was not found. Check it in the settings, then send again."]] as const) {
      waits.length = 0;
      const { infos, on } = heard();
      await expect(new RetryProvider(new ChatCompletionsProvider({ baseUrl: base, model: "m" }), options).stream(req, signal(), on)).rejects.toThrow(message);
      expect(waits).toEqual([]);
      expect(infos).toEqual([]);
    }
  });

  test("a dropped connection before anything was said is tried again", async () => {
    waits.length = 0;
    const inner = flaky([new TypeError("fetch failed")]);
    const { infos, on } = heard();
    await new RetryProvider(inner, options).stream(req, signal(), on);
    expect(inner.calls).toBe(2);
    expect(infos[0]!.reason).toBe("the connection to the model dropped");
  });

  test("a stream that had begun to say something is never made again behind the person's back", async () => {
    waits.length = 0;
    const halfway: Provider = { async stream(_r, _s, on) { on.text("par"); throw status(502); }, async complete() { return ""; } };
    const said: string[] = [];
    const { infos, on } = heard();
    await expect(new RetryProvider(halfway, options).stream(req, signal(), { ...on, text: (d) => said.push(d) })).rejects.toThrow("502");
    expect(said).toEqual(["par"]);
    expect(waits).toEqual([]);
    expect(infos).toEqual([]);
  });

  test("it gives up after the most tries, with the last failure, having announced every wait but the first call", async () => {
    waits.length = 0;
    const inner = flaky(Array.from({ length: 20 }, () => status(503)));
    const { infos, on } = heard();
    await expect(new RetryProvider(inner, options).stream(req, signal(), on)).rejects.toThrow("503");
    expect(inner.calls).toBe(MAX_ATTEMPTS);
    expect(infos.map((i) => i.attempt)).toEqual([2, 3, 4, 5, 6, 7, 8]);
    expect(waits).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  });

  test("the waits never add up to more than the most: a Retry-After that would pass it ends the tries", async () => {
    waits.length = 0;
    const inner = flaky([status(429, MOST_WAIT_MS - 1000), status(429, 5000)]);
    const { infos, on } = heard();
    await expect(new RetryProvider(inner, options).stream(req, signal(), on)).rejects.toThrow("429");
    expect(inner.calls).toBe(2);
    expect(infos).toHaveLength(1);
  });

  test("stopping ends the wait at once, and the failure is the one that was waited on", async () => {
    const stop = new AbortController();
    const { infos, on } = heard();
    const done = new RetryProvider(flaky([status(429, 60_000)])).stream(req, stop.signal, on);
    const settled = done.then(() => "answered", (e: Error) => e.message);
    while (!infos.length) await new Promise((r) => setTimeout(r, 5));
    const started = Date.now();
    stop.abort();
    expect(await settled).toBe("answered 429");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test("the number of tries can be set: one try never repeats a call, and three say so in `of`", async () => {
    waits.length = 0;
    const once = flaky([status(503)]);
    await expect(new RetryProvider(once, { ...options, attempts: 1 }).stream(req, signal(), noop)).rejects.toThrow("503");
    expect(once.calls).toBe(1);
    const { infos, on } = heard();
    await expect(new RetryProvider(flaky(Array.from({ length: 5 }, () => status(503))), { ...options, attempts: 3 }).stream(req, signal(), on)).rejects.toThrow("503");
    expect(infos).toEqual([
      { reason: "the model is busy", attempt: 2, of: 3, inSeconds: 1 },
      { reason: "the model is busy", attempt: 3, of: 3, inSeconds: 2 },
    ]);
  });

  test("a call that is not a stream (the summary of a long conversation) is made again too, and says so the same way", async () => {
    waits.length = 0;
    const infos: RetryInfo[] = [];
    expect(await new RetryProvider(flaky([status(500)], "SUMMARY"), options).complete("s", "u", signal(), { retry: (i) => infos.push(i) })).toBe("SUMMARY");
    expect(infos).toEqual([{ reason: "the model's server had a problem", attempt: 2, of: MAX_ATTEMPTS, inSeconds: 1 }]);
  });
});

describe("another model is asked only after the tries are used up", () => {
  test("every try is made on the first model before the second answers, and the person is told once", async () => {
    waits.length = 0;
    const first = flaky(Array.from({ length: 20 }, () => status(503)));
    const second = flaky([], "from the second");
    const told: string[] = [];
    const { infos, on } = heard();
    const chain = new FallbackProvider([{ name: "Main", provider: first }, { name: "Backup", provider: second }], (m) => told.push(m), options);
    expect((await chain.stream(req, signal(), on)).content).toBe("from the second");
    expect(first.calls).toBe(MAX_ATTEMPTS);
    expect(second.calls).toBe(1);
    expect(infos).toHaveLength(MAX_ATTEMPTS - 1);
    expect(told).toHaveLength(1);
  });
});

describe("what the engine says while it waits", () => {
  test("a busy model is tried again by itself, the turn finishes, and a retry event came first", async () => {
    let calls = 0;
    const provider: Provider = {
      async stream(_r, _s, on) { if (calls++ === 0) throw status(529, 0); on.text("here now"); return reply("here now"); },
      async complete() { return ""; },
    };
    const r = rig(() => ({ text: "unused" }), { provider });
    await r.turn(prompt("hello"));
    expect(r.of("retry")).toEqual([{ ev: "retry", reason: "the model is busy", attempt: 2, of: MAX_ATTEMPTS, inSeconds: 1 }]);
    expect(r.text()).toContain("here now");
    expect(r.of("error")).toEqual([]);
    expect(r.of("done").at(-1)).toMatchObject({ stop: "end_turn" });
    r.cleanup();
  });
});

describe("a limit that is used up is not a slow-down", () => {
  const spent = (): ProviderError => new ProviderError('the model endpoint answered 429: {"error":{"message":"This session has used all it may. Start a new one.","type":"budget_exhausted"}}', 429);

  test("it is not tried again, and it says so in plain words", () => {
    const e = spent();
    expect(e.spent).toBe(true);
    expect(retryable(e)).toBe(false);
    expect(e.message).toBe("This is not a slow-down: This session has used all it may. Start a new one. Trying again will not help.");
    expect(retryable(new ProviderError("the model endpoint answered 429: slow down", 429))).toBe(true);
    expect(new ProviderError("slow down", 429).spent).toBe(false);
  });

  test("the call is made once", async () => {
    const inner = flaky([spent(), spent(), spent()]);
    const { on } = heard();
    await expect(new RetryProvider(inner, options).stream(req, signal(), on)).rejects.toThrow("Trying again will not help");
    expect(inner.calls).toBe(1);
  });
});
