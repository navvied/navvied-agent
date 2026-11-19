import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { OllamaProvider, ProviderError, toOllamaWire } from "../src/index.ts";
import type { ModelRequest, StreamHandlers } from "../src/index.ts";

let server: ReturnType<typeof Bun.serve>;
let seen: { path: string; body: any }[] = [];
let respond: (body: any) => Response = () => new Response("not set", { status: 500 });

const lines = (chunks: object[]): Response => new Response(chunks.map((c) => `${JSON.stringify(c)}\n`).join(""), { headers: { "content-type": "application/x-ndjson" } });

beforeAll(() => { server = Bun.serve({ port: 0, async fetch(req) { const body = await req.json(); seen.push({ path: new URL(req.url).pathname, body }); return respond(body); } }); });
afterAll(() => server.stop(true));

const provider = (extra = {}) => new OllamaProvider({ baseUrl: `http://127.0.0.1:${server.port}`, model: "qwen-test", contextTokens: 16384, ...extra });
const request = (over: Partial<ModelRequest> = {}): ModelRequest => ({ system: "be brief", messages: [{ role: "user", content: "hello" }], tools: [], ...over });
const handlers = () => {
  const got = { text: "", thought: "", started: [] as string[] };
  const on: StreamHandlers = { text: (d) => { got.text += d; }, thought: (d) => { got.thought += d; }, toolStarted: (id, name) => { got.started.push(name); void id; } };
  return { got, on };
};

describe("the conversation as Ollama wants it", () => {
  test("the system prompt comes first, images ride along, tool calls carry parsed arguments, and results name their tool", () => {
    const wire = toOllamaWire([
      { role: "user", content: [{ type: "text", text: "what is this" }, { type: "image", mime: "image/png", data: "AAAA" }] },
      { role: "assistant", content: "Looking.", toolCalls: [{ id: "t1", name: "Read", arguments: "{file_path:'a.ts',}" }] },
      { role: "tool", toolCallId: "t1", content: "file text" },
      { role: "tool", toolCallId: "unknown", content: "" },
      { role: "assistant", content: "" },
    ], "SYS");
    expect(wire).toEqual([
      { role: "system", content: "SYS" },
      { role: "user", content: "what is this", images: ["AAAA"] },
      { role: "assistant", content: "Looking.", tool_calls: [{ function: { name: "Read", arguments: { file_path: "a.ts" } } }] },
      { role: "tool", tool_name: "Read", content: "file text" },
      { role: "tool", tool_name: "", content: "(no output)" },
    ]);
  });
});

describe("streaming from Ollama", () => {
  test("text arrives as it is written, with the usage, and the request asks for the memory it needs and carries the tools", async () => {
    seen = [];
    respond = () => lines([
      { message: { role: "assistant", content: "Hel" }, done: false },
      { message: { role: "assistant", content: "lo" }, done: false },
      { message: { role: "assistant", content: "" }, done: true, done_reason: "stop", prompt_eval_count: 40, eval_count: 6 },
    ]);
    const { got, on } = handlers();
    const reply = await provider().stream(request({ tools: [{ name: "Read", description: "Read a file", parameters: { type: "object", properties: {} } }] }), new AbortController().signal, on);
    expect(got.text).toBe("Hello");
    expect(reply).toMatchObject({ content: "Hello", finish: "stop", calls: [], usage: { prompt: 40, completion: 6 } });
    expect(seen[0]!.path).toBe("/api/chat");
    expect(seen[0]!.body).toMatchObject({ model: "qwen-test", stream: true, options: { num_ctx: 16384 }, tools: [{ type: "function", function: { name: "Read", description: "Read a file", parameters: { type: "object", properties: {} } } }] });
    expect(seen[0]!.body.messages[0]).toEqual({ role: "system", content: "be brief" });
  });

  test("a tool call arrives whole, gets an id, is announced, and its arguments are text for the engine", async () => {
    respond = () => lines([
      { message: { role: "assistant", thinking: "I should read it." }, done: false },
      { message: { role: "assistant", content: "", tool_calls: [{ function: { name: "Read", arguments: { file_path: "a.ts" } } }, { function: { name: "Glob", arguments: { pattern: "*.ts" } } }] }, done: false },
      { done: true, done_reason: "stop", prompt_eval_count: 5, eval_count: 9 },
    ]);
    const { got, on } = handlers();
    const reply = await provider().stream(request(), new AbortController().signal, on);
    expect(got.thought).toBe("I should read it.");
    expect(got.started).toEqual(["Read", "Glob"]);
    expect(reply.calls.map((c) => [c.name, c.arguments])).toEqual([["Read", '{"file_path":"a.ts"}'], ["Glob", '{"pattern":"*.ts"}']]);
    expect(new Set(reply.calls.map((c) => c.id)).size).toBe(2);
  });

  test("lines split across chunks are put back together", async () => {
    respond = () => {
      const text = `${JSON.stringify({ message: { content: "ab" }, done: false })}\n${JSON.stringify({ done: true, prompt_eval_count: 1, eval_count: 2 })}\n`;
      return new Response(new ReadableStream({ start(c) { const e = new TextEncoder(); c.enqueue(e.encode(text.slice(0, 17))); c.enqueue(e.encode(text.slice(17))); c.close(); } }));
    };
    const { got, on } = handlers();
    const reply = await provider().stream(request(), new AbortController().signal, on);
    expect(got.text).toBe("ab");
    expect(reply.usage).toEqual({ prompt: 1, completion: 2 });
  });

  test("a refusal says why in the server's words and carries the status, an error in the stream is raised, and a stop aborts", async () => {
    respond = () => new Response(JSON.stringify({ error: "model 'nope' not found" }), { status: 404 });
    const error = await provider().stream(request(), new AbortController().signal, handlers().on).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).message).toBe("the model server answered 404: model 'nope' not found");
    respond = () => lines([{ error: "out of memory" }]);
    await expect(provider().stream(request(), new AbortController().signal, handlers().on)).rejects.toThrow(/out of memory/);
    respond = () => new Response(new ReadableStream({ start() {} }));
    const controller = new AbortController();
    const pending = provider().stream(request(), controller.signal, handlers().on);
    setTimeout(() => controller.abort(), 30);
    await expect(pending).rejects.toBeDefined();
  });

  test("a short answer for summarising keeps the same memory, and an empty one is an error", async () => {
    seen = [];
    respond = () => Response.json({ message: { content: "A summary." }, done: true });
    expect(await provider().complete("sum up", "long text", new AbortController().signal)).toBe("A summary.");
    expect(seen[0]!.body).toMatchObject({ stream: false, options: { num_ctx: 16384 }, messages: [{ role: "system", content: "sum up" }, { role: "user", content: "long text" }] });
    respond = () => Response.json({ message: { content: " " }, done: true });
    await expect(provider().complete("s", "u", new AbortController().signal)).rejects.toThrow(/empty answer/);
  });
});
