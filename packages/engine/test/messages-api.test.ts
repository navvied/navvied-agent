import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { MessagesApiProvider, ProviderError, toMessagesWire } from "../src/index.ts";
import type { Message, ModelRequest, StreamHandlers } from "../src/index.ts";

interface Seen { path: string; headers: Headers; body: any }
let server: ReturnType<typeof Bun.serve>;
let seen: Seen[] = [];
let respond: (req: Request, body: any) => Response = () => new Response("not set", { status: 500 });

const sse = (events: object[]): Response =>
  new Response(events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });

beforeAll(() => {
  server = Bun.serve({ port: 0, async fetch(req) {
    const body = await req.json();
    seen.push({ path: new URL(req.url).pathname, headers: req.headers, body });
    return respond(req, body);
  } });
});
afterAll(() => server.stop(true));

const provider = (extra = {}) => new MessagesApiProvider({ baseUrl: `http://127.0.0.1:${server.port}/v1`, model: "test-model", apiKey: "sk-test-key", ...extra });
const request = (over: Partial<ModelRequest> = {}): ModelRequest => ({ system: "be brief", messages: [{ role: "user", content: "hello" }], tools: [], ...over });
const handlers = () => {
  const got = { text: "", thought: "", started: [] as string[] };
  const on: StreamHandlers = { text: (d) => { got.text += d; }, thought: (d) => { got.thought += d; }, toolStarted: (id, name) => { got.started.push(`${id}:${name}`); } };
  return { got, on };
};

describe("the conversation as the messages API wants it", () => {
  test("a tool call is a block in the assistant's message and its results travel together in the user's next message", () => {
    const messages: Message[] = [
      { role: "user", content: "read two files" },
      { role: "assistant", content: "On it.", toolCalls: [{ id: "t1", name: "Read", arguments: '{"file_path":"a.ts"}' }, { id: "t2", name: "Read", arguments: '{"file_path":"b.ts"}' }] },
      { role: "tool", toolCallId: "t1", content: "A" },
      { role: "tool", toolCallId: "t2", content: "B" },
      { role: "user", content: "and then?" },
    ];
    expect(toMessagesWire(messages)).toEqual([
      { role: "user", content: [{ type: "text", text: "read two files" }] },
      { role: "assistant", content: [{ type: "text", text: "On it." }, { type: "tool_use", id: "t1", name: "Read", input: { file_path: "a.ts" } }, { type: "tool_use", id: "t2", name: "Read", input: { file_path: "b.ts" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "A" }, { type: "tool_result", tool_use_id: "t2", content: "B" }, { type: "text", text: "and then?" }] },
    ]);
  });

  test("images become base64 sources, empty messages are dropped, and an empty tool result still says something", () => {
    const wire = toMessagesWire([
      { role: "user", content: [{ type: "text", text: "what is this" }, { type: "image", mime: "image/png", data: "AAAA" }] },
      { role: "assistant", content: "" },
      { role: "assistant", toolCalls: [{ id: "t", name: "Bash", arguments: "{}" }] },
      { role: "tool", toolCallId: "t", content: "" },
    ]);
    expect(wire[0]!.content).toEqual([{ type: "text", text: "what is this" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }]);
    expect(wire).toHaveLength(3);
    expect(wire[2]!.content).toEqual([{ type: "tool_result", tool_use_id: "t", content: "(no output)" }]);
  });

  test("tool arguments a small model got slightly wrong are repaired, and hopeless ones become an empty object", () => {
    const wire = toMessagesWire([
      { role: "assistant", toolCalls: [{ id: "a", name: "Read", arguments: "{file_path:'a.ts',}" }, { id: "b", name: "Read", arguments: "not json" }] },
    ]);
    expect(wire[0]!.content).toEqual([{ type: "tool_use", id: "a", name: "Read", input: { file_path: "a.ts" } }, { type: "tool_use", id: "b", name: "Read", input: {} }]);
  });
});

describe("streaming from the messages API", () => {
  test("text arrives as it is written, with the usage counted, and the request carries the key, the version and the tools", async () => {
    seen = [];
    respond = () => sse([
      { type: "message_start", message: { usage: { input_tokens: 25, cache_read_input_tokens: 5, output_tokens: 1 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } },
      { type: "message_stop" },
    ]);
    const { got, on } = handlers();
    const reply = await provider().stream(request({ tools: [{ name: "Read", description: "Read a file", parameters: { type: "object", properties: {} } }] }), new AbortController().signal, on);
    expect(got.text).toBe("Hello");
    expect(reply).toMatchObject({ content: "Hello", finish: "end_turn", calls: [], usage: { prompt: 30, completion: 7 } });
    const s = seen[0]!;
    expect(s.path).toBe("/v1/messages");
    expect(s.headers.get("x-api-key")).toBe("sk-test-key");
    expect(s.headers.get("anthropic-version")).toBe("2023-06-01");
    expect(s.body).toMatchObject({ model: "test-model", stream: true, max_tokens: 8192, system: "be brief", messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }], tools: [{ name: "Read", description: "Read a file", input_schema: { type: "object", properties: {} } }] });
  });

  test("a tool call arrives in pieces and is put together; the tool is announced as soon as it is named; reasoning is passed on", async () => {
    respond = () => sse([
      { type: "message_start", message: { usage: { input_tokens: 10 } } },
      { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "I should read it." } },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "Read" } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"file_' } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: 'path":"a.ts"}' } },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 20 } },
    ]);
    const { got, on } = handlers();
    const reply = await provider().stream(request(), new AbortController().signal, on);
    expect(got.thought).toBe("I should read it.");
    expect(got.started).toEqual(["toolu_1:Read"]);
    expect(reply.calls).toEqual([{ id: "toolu_1", name: "Read", arguments: '{"file_path":"a.ts"}' }]);
    expect(reply.finish).toBe("tool_use");
  });

  test("a refused request says why in the words of the service, and carries the status", async () => {
    respond = () => new Response(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }), { status: 401 });
    const error = await provider().stream(request(), new AbortController().signal, handlers().on).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).message).toBe("the model endpoint answered 401: invalid x-api-key");
    expect((error as ProviderError).status).toBe(401);
  });

  test("an error in the middle of the stream is raised, not swallowed", async () => {
    respond = () => sse([{ type: "message_start", message: { usage: {} } }, { type: "error", error: { message: "Overloaded" } }]);
    await expect(provider().stream(request(), new AbortController().signal, handlers().on)).rejects.toThrow(/Overloaded/);
  });

  test("stopping the turn aborts the request", async () => {
    respond = () => new Response(new ReadableStream({ start() {} }), { headers: { "content-type": "text/event-stream" } });
    const controller = new AbortController();
    const pending = provider().stream(request(), controller.signal, handlers().on);
    setTimeout(() => controller.abort(), 30);
    await expect(pending).rejects.toBeDefined();
  });

  test("the limit on one answer can be set", async () => {
    seen = [];
    respond = () => sse([{ type: "message_stop" }]);
    await provider({ maxTokens: 1000 }).stream(request(), new AbortController().signal, handlers().on);
    expect(seen[0]!.body.max_tokens).toBe(1000);
  });
});

describe("a short answer for summarising", () => {
  test("it returns the text, and an empty answer is an error", async () => {
    respond = () => Response.json({ content: [{ type: "text", text: "A summary." }] });
    expect(await provider().complete("sum up", "long text", new AbortController().signal)).toBe("A summary.");
    expect(seen.at(-1)!.body).toMatchObject({ system: "sum up", messages: [{ role: "user", content: "long text" }] });
    respond = () => Response.json({ content: [] });
    await expect(provider().complete("s", "u", new AbortController().signal)).rejects.toThrow(/empty answer/);
  });
});
