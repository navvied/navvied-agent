import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ProviderError, ResponsesApiProvider, toResponsesInput } from "../src/index.ts";
import type { Message, ModelRequest, StreamHandlers } from "../src/index.ts";

interface Seen { path: string; headers: Headers; body: any }
let server: ReturnType<typeof Bun.serve>;
let seen: Seen[] = [];
let respond: (req: Request, body: any) => Response = () => new Response("not set", { status: 500 });

const sse = (events: object[]): Response =>
  new Response(events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });

beforeAll(() => { server = Bun.serve({ port: 0, async fetch(req) { const body = await req.json(); seen.push({ path: new URL(req.url).pathname, headers: req.headers, body }); return respond(req, body); } }); });
afterAll(() => server.stop(true));

const provider = (extra = {}) => new ResponsesApiProvider({ baseUrl: `http://127.0.0.1:${server.port}/v1`, model: "test-model", apiKey: "sk-test-key", ...extra });
const request = (over: Partial<ModelRequest> = {}): ModelRequest => ({ system: "be brief", messages: [{ role: "user", content: "hello" }], tools: [], ...over });
const handlers = () => {
  const got = { text: "", thought: "", started: [] as string[] };
  const on: StreamHandlers = { text: (d) => { got.text += d; }, thought: (d) => { got.thought += d; }, toolStarted: (id, name) => { got.started.push(`${id}:${name}`); } };
  return { got, on };
};

describe("the conversation as the responses API wants it", () => {
  test("messages, tool calls and their results are items one after another, paired by the call id", () => {
    const messages: Message[] = [
      { role: "user", content: "read a file" },
      { role: "assistant", content: "On it.", toolCalls: [{ id: "c1", name: "Read", arguments: '{"file_path":"a.ts"}' }, { id: "c2", name: "Read", arguments: "" }] },
      { role: "tool", toolCallId: "c1", content: "A" },
      { role: "tool", toolCallId: "c2", content: "" },
      { role: "user", content: [{ type: "text", text: "look" }, { type: "image", mime: "image/png", data: "AAAA" }] },
    ];
    expect(toResponsesInput(messages)).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "read a file" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "On it." }] },
      { type: "function_call", call_id: "c1", name: "Read", arguments: '{"file_path":"a.ts"}' },
      { type: "function_call", call_id: "c2", name: "Read", arguments: "{}" },
      { type: "function_call_output", call_id: "c1", output: "A" },
      { type: "function_call_output", call_id: "c2", output: "(no output)" },
      { type: "message", role: "user", content: [{ type: "input_text", text: "look" }, { type: "input_image", image_url: "data:image/png;base64,AAAA" }] },
    ]);
  });
  test("an assistant turn with only tool calls adds no empty message", () => {
    expect(toResponsesInput([{ role: "assistant", toolCalls: [{ id: "c", name: "Bash", arguments: "{}" }] }])).toEqual([{ type: "function_call", call_id: "c", name: "Bash", arguments: "{}" }]);
  });
});

describe("a streamed answer", () => {
  test("sends the system text as instructions, the tools as functions and the key as a bearer token, and streams text, reasoning and usage", async () => {
    seen = [];
    respond = () => sse([
      { type: "response.reasoning_summary_text.delta", delta: "thinking" },
      { type: "response.output_text.delta", delta: "Hel" },
      { type: "response.output_text.delta", delta: "lo" },
      { type: "response.completed", response: { status: "completed", usage: { input_tokens: 12, output_tokens: 3 } } },
    ]);
    const { got, on } = handlers();
    const reply = await provider().stream(request({ tools: [{ name: "Read", description: "reads", parameters: { type: "object", properties: {} } }], effort: "high" }), new AbortController().signal, on);
    expect(got).toEqual({ text: "Hello", thought: "thinking", started: [] });
    expect(reply).toMatchObject({ content: "Hello", calls: [], finish: "completed", usage: { prompt: 12, completion: 3 } });
    expect(seen[0]!.path).toBe("/v1/responses");
    expect(seen[0]!.headers.get("authorization")).toBe("Bearer sk-test-key");
    expect(seen[0]!.body).toMatchObject({ model: "test-model", instructions: "be brief", stream: true, store: false, reasoning: { effort: "high" } });
    expect(seen[0]!.body.tools).toEqual([{ type: "function", name: "Read", description: "reads", parameters: { type: "object", properties: {} } }]);
    expect(seen[0]!.body.input).toEqual([{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }]);
  });
  test("a higher effort than the API knows asks for the highest, and no effort sends none", async () => {
    seen = [];
    respond = () => sse([{ type: "response.completed", response: { usage: {} } }]);
    await provider().stream(request({ effort: "max" }), new AbortController().signal, handlers().on);
    await provider().stream(request(), new AbortController().signal, handlers().on);
    expect(seen[0]!.body.reasoning.effort).toBe("high");
    expect(seen[1]!.body).not.toHaveProperty("reasoning");
    expect(seen[1]!.body).not.toHaveProperty("tools");
  });
  test("a tool call is announced when it starts and arrives complete, in the order the model made them", async () => {
    respond = () => sse([
      { type: "response.output_item.added", item: { type: "function_call", id: "i1", call_id: "call_1", name: "Read", arguments: "" } },
      { type: "response.output_item.added", item: { type: "function_call", id: "i2", call_id: "call_2", name: "Grep", arguments: "" } },
      { type: "response.function_call_arguments.delta", item_id: "i1", delta: '{"file_' },
      { type: "response.function_call_arguments.delta", item_id: "i1", delta: 'path":"a.ts"}' },
      { type: "response.function_call_arguments.delta", item_id: "i2", delta: '{"pattern":' },
      { type: "response.output_item.done", item: { type: "function_call", id: "i2", call_id: "call_2", name: "Grep", arguments: '{"pattern":"x"}' } },
      { type: "response.completed", response: { usage: { input_tokens: 5, output_tokens: 7 } } },
    ]);
    const { got, on } = handlers();
    const reply = await provider().stream(request(), new AbortController().signal, on);
    expect(got.started).toEqual(["call_1:Read", "call_2:Grep"]);
    expect(reply.calls).toEqual([{ id: "call_1", name: "Read", arguments: '{"file_path":"a.ts"}' }, { id: "call_2", name: "Grep", arguments: '{"pattern":"x"}' }]);
  });
  test("an error in the stream or from the endpoint is a plain ProviderError", async () => {
    respond = () => sse([{ type: "response.failed", response: { error: { message: "context too long" } } }]);
    await expect(provider().stream(request(), new AbortController().signal, handlers().on)).rejects.toThrow("the model endpoint reported an error: context too long");
    respond = () => sse([{ type: "error", message: "rate limited" }]);
    await expect(provider().stream(request(), new AbortController().signal, handlers().on)).rejects.toThrow("rate limited");
    respond = () => new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 401 });
    const caught = await provider().stream(request(), new AbortController().signal, handlers().on).catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(ProviderError);
    expect((caught as ProviderError).message).toBe("the model endpoint answered 401: bad key");
  });
  test("unreadable lines are skipped and extra headers are sent", async () => {
    seen = [];
    respond = () => new Response('data: nope\n\ndata: {"type":"response.output_text.delta","delta":"ok"}\n\ndata: {"type":"response.completed","response":{"usage":{}}}\n\n', { headers: { "content-type": "text/event-stream" } });
    const { got, on } = handlers();
    await provider({ headers: { "x-extra": "1" } }).stream(request(), new AbortController().signal, on);
    expect(got.text).toBe("ok");
    expect(seen[0]!.headers.get("x-extra")).toBe("1");
  });
});

describe("a short answer without streaming", () => {
  test("joins the text of the message items, and refuses an empty answer", async () => {
    respond = () => new Response(JSON.stringify({ output: [{ type: "reasoning" }, { type: "message", content: [{ type: "output_text", text: "A summary" }, { type: "output_text", text: "." }] }] }));
    expect(await provider().complete("sys", "user", new AbortController().signal)).toBe("A summary.");
    respond = () => new Response(JSON.stringify({ output: [] }));
    await expect(provider().complete("sys", "user", new AbortController().signal)).rejects.toThrow("empty answer");
  });
});

describe("a saved sign-in instead of a key", () => {
  const creds = { headers: async () => ({ authorization: "Bearer login-token", "x-account-id": "acct-9" }), body: (b: Record<string, unknown>) => ({ ...b, store: false, stream: true }) };
  const done = [{ type: "response.output_text.delta", delta: "hi there" }, { type: "response.completed", response: { status: "completed", usage: { input_tokens: 3, output_tokens: 2 } } }];

  test("its headers go out in place of the key, and it shapes the body", async () => {
    seen = [];
    respond = () => sse(done);
    const { got, on } = handlers();
    await new ResponsesApiProvider({ baseUrl: `http://127.0.0.1:${server.port}/v1`, model: "m", credentials: creds }).stream(request(), new AbortController().signal, on);
    expect(got.text).toBe("hi there");
    expect(seen[0]!.headers.get("authorization")).toBe("Bearer login-token");
    expect(seen[0]!.headers.get("x-account-id")).toBe("acct-9");
    expect(seen[0]!.body).toMatchObject({ store: false, stream: true });
  });
  test("a short question for the engine itself is asked as a stream too, and read from it", async () => {
    seen = [];
    respond = () => sse(done);
    const answer = await new ResponsesApiProvider({ baseUrl: `http://127.0.0.1:${server.port}/v1`, model: "m", credentials: creds }).complete("be brief", "say hi", new AbortController().signal);
    expect(answer).toBe("hi there");
    expect(seen[0]!.body.stream).toBe(true);
  });
});
