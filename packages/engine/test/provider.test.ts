import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ChatCompletionsProvider, ProviderError, toWire } from "../src/index.ts";
import { sseData } from "../src/providers/sse.ts";
import type { Message, StreamHandlers } from "../src/types.ts";

interface Seen { auth: string | null; body: any }
let seen: Seen[] = [];
let server: ReturnType<typeof Bun.serve>;
let mode = "tools";
const sse = (chunks: unknown[], tail = "data: [DONE]\n\n") => new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + tail, { headers: { "content-type": "text/event-stream" } });

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body: any = await req.json();
      seen.push({ auth: req.headers.get("authorization"), body });
      if (!body.stream) return Response.json({ choices: [{ message: { content: mode === "empty" ? "" : "the summary" } }] });
      if (mode === "error") return new Response("rate limited, slow down", { status: 429 });
      if (mode === "text") return sse([{ choices: [{ delta: { content: "Hel" } }] }, { choices: [{ delta: { content: "lo" } }] }, { choices: [{ delta: {}, finish_reason: "stop" }] }, { choices: [], usage: { prompt_tokens: 11, completion_tokens: 2 } }]);
      // tool call arguments split across chunks, two calls, reasoning text, and CRLF line endings in the stream
      return sse([
        { choices: [{ delta: { reasoning_content: "let me think" } }] },
        { choices: [{ delta: { content: "Reading. " } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "Read", arguments: "" } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"file_pa' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 1, id: "call_b", type: "function", function: { name: "Glob", arguments: '{"pattern":"*"}' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.ts"}' } }] } }] },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
        { choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } },
      ]);
    },
  });
});
afterAll(() => server.stop(true));

const base = () => `http://127.0.0.1:${server.port}/v1`;
const handlers = () => {
  const log = { text: "", thought: "", started: [] as string[] };
  const h: StreamHandlers = { text: (d) => { log.text += d; }, thought: (d) => { log.thought += d; }, toolStarted: (id, name) => { log.started.push(`${id}:${name}`); } };
  return { log, h };
};

describe("ChatCompletionsProvider", () => {
  test("streams text and usage", async () => {
    seen = []; mode = "text";
    const { log, h } = handlers();
    const p = new ChatCompletionsProvider({ baseUrl: base(), model: "m1", apiKey: "sk-test" });
    const reply = await p.stream({ system: "sys", messages: [{ role: "user", content: "hi" }], tools: [] }, new AbortController().signal, h);
    expect(log.text).toBe("Hello");
    expect(reply).toMatchObject({ content: "Hello", finish: "stop", calls: [], usage: { prompt: 11, completion: 2 } });
    expect(seen[0]!.auth).toBe("Bearer sk-test");
    expect(seen[0]!.body).toMatchObject({ model: "m1", stream: true, stream_options: { include_usage: true } });
    expect(seen[0]!.body.messages[0]).toEqual({ role: "system", content: "sys" });
    expect(seen[0]!.body.tools).toBeUndefined();
  });

  test("a sign-in object supplies the headers of every request, fresh each time, and wins over a saved key", async () => {
    seen = []; mode = "text";
    let n = 0;
    const credentials = { headers: async () => ({ authorization: `Bearer token-${++n}` }), body: (b: Record<string, unknown>) => b };
    const p = new ChatCompletionsProvider({ baseUrl: base(), model: "m", apiKey: "sk-ignored" }, credentials);
    const ask = () => p.stream({ system: "s", messages: [{ role: "user", content: "hi" }], tools: [] }, new AbortController().signal, handlers().h);
    await ask();
    await ask();
    await p.complete("s", "u", new AbortController().signal);
    expect(seen.map((x) => x.auth)).toEqual(["Bearer token-1", "Bearer token-2", "Bearer token-3"]);
  });

  test("reassembles tool calls whose arguments arrive in pieces, in order, and announces them early", async () => {
    seen = []; mode = "tools";
    const { log, h } = handlers();
    const p = new ChatCompletionsProvider({ baseUrl: `${base()}/`, model: "m" });
    const reply = await p.stream({ system: "s", messages: [{ role: "user", content: "go" }], tools: [{ name: "Read", description: "d", parameters: { type: "object" } }] }, new AbortController().signal, h);
    expect(reply.calls).toEqual([
      { id: "call_a", name: "Read", arguments: '{"file_path":"a.ts"}' },
      { id: "call_b", name: "Glob", arguments: '{"pattern":"*"}' },
    ]);
    expect(JSON.parse(reply.calls[0]!.arguments)).toEqual({ file_path: "a.ts" });
    expect(reply.finish).toBe("tool_calls");
    expect(log.thought).toBe("let me think");
    expect(log.text).toBe("Reading. ");
    expect(log.started).toEqual(["call_a:Read", "call_b:Glob"]);
    expect(seen[0]!.auth).toBeNull(); // no key configured → no header
    expect(seen[0]!.body.tools[0]).toEqual({ type: "function", function: { name: "Read", description: "d", parameters: { type: "object" } } });
  });

  test("effort is sent as reasoning_effort unless the provider is configured to never take it", async () => {
    mode = "text"; seen = [];
    const req = { system: "s", messages: [], tools: [], effort: "high" };
    await new ChatCompletionsProvider({ baseUrl: base(), model: "m" }).stream(req, new AbortController().signal, handlers().h);
    await new ChatCompletionsProvider({ baseUrl: base(), model: "m", reasoning: "none" }).stream(req, new AbortController().signal, handlers().h);
    expect(seen[0]!.body.reasoning_effort).toBe("high");
    expect(seen[1]!.body.reasoning_effort).toBeUndefined();
  });

  test("an HTTP error becomes a ProviderError with the status and the server's words", async () => {
    mode = "error";
    const p = new ChatCompletionsProvider({ baseUrl: base(), model: "m" });
    const err = await p.stream({ system: "s", messages: [], tools: [] }, new AbortController().signal, handlers().h).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.status).toBe(429);
    expect(err.message).toMatch(/429.*rate limited/);
  });

  test("an unreachable endpoint rejects instead of hanging", async () => {
    const p = new ChatCompletionsProvider({ baseUrl: "http://127.0.0.1:1/v1", model: "m" });
    await expect(p.stream({ system: "s", messages: [], tools: [] }, new AbortController().signal, handlers().h)).rejects.toBeDefined();
  });

  test("aborting the signal rejects the stream", async () => {
    mode = "text";
    const ac = new AbortController(); ac.abort();
    const p = new ChatCompletionsProvider({ baseUrl: base(), model: "m" });
    await expect(p.stream({ system: "s", messages: [], tools: [] }, ac.signal, handlers().h)).rejects.toBeDefined();
  });

  test("complete() returns the text and refuses an empty answer", async () => {
    const p = new ChatCompletionsProvider({ baseUrl: base(), model: "m" });
    mode = "text"; seen = [];
    expect(await p.complete("sys", "user text", new AbortController().signal)).toBe("the summary");
    expect(seen[0]!.body.stream).toBe(false);
    mode = "empty";
    await expect(p.complete("s", "u", new AbortController().signal)).rejects.toThrow(/empty answer/);
  });
});

describe("wire format", () => {
  test("messages map to the wire shape: parts, images, tool calls and tool results", () => {
    const msgs: Message[] = [
      { role: "user", content: [{ type: "text", text: "look" }, { type: "image", mime: "image/png", data: "AAA" }] },
      { role: "assistant", toolCalls: [{ id: "c1", name: "Read", arguments: "{}" }] },
      { role: "tool", toolCallId: "c1", content: "file text" },
      { role: "assistant", content: "done" },
    ];
    expect(msgs.map(toWire)).toEqual([
      { role: "user", content: [{ type: "text", text: "look" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } }] },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "Read", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: "file text" },
      { role: "assistant", content: "done" },
    ]);
  });
});

describe("sse reader", () => {
  const stream = (...chunks: string[]) => new ReadableStream<Uint8Array>({ start(c) { for (const x of chunks) c.enqueue(new TextEncoder().encode(x)); c.close(); } });
  const collect = async (s: ReadableStream<Uint8Array>) => { const out: string[] = []; for await (const d of sseData(s)) out.push(d); return out; };

  test("handles events split across chunks, CRLF, comments and the end marker", async () => {
    expect(await collect(stream("data: {\"a\"", ":1}\r\n\r\n: keep-alive\n\ndata: {\"b\":2}\n\nda", "ta: [DONE]\n\ndata: {\"never\":1}\n\n"))).toEqual(['{"a":1}', '{"b":2}']);
  });
  test("a final event without a trailing newline is not lost", async () => {
    expect(await collect(stream('data: {"x":1}\n\ndata: {"y":2}'))).toEqual(['{"x":1}', '{"y":2}']);
  });
  test("multi-byte characters split across chunks survive", async () => {
    const bytes = new TextEncoder().encode('data: {"t":"日本語"}\n\n');
    const s = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes.slice(0, 13)); c.enqueue(bytes.slice(13)); c.close(); } });
    expect(await collect(s)).toEqual(['{"t":"日本語"}']);
  });
});
