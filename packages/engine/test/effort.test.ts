import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ChatCompletionsProvider, MessagesApiProvider, ResponsesApiProvider } from "../src/index.ts";
import type { ModelRequest, Provider, StreamHandlers } from "../src/index.ts";
import { HOOK_MS, cleanupAll, prompt, rig } from "./helpers.ts";

afterAll(cleanupAll, HOOK_MS);

let server: ReturnType<typeof Bun.serve>;
let seen: { path: string; body: any }[] = [];
let answer: (path: string, body: any) => Response | undefined = () => undefined;
const sse = (text: string): Response => new Response(text, { headers: { "content-type": "text/event-stream" } });
const events = (list: object[]): string => list.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join("");

beforeAll(() => {
  server = Bun.serve({ port: 0, async fetch(req) {
    const path = new URL(req.url).pathname, body: any = await req.json();
    seen.push({ path, body });
    const custom = answer(path, body);
    if (custom) return custom;
    if (path.endsWith("/chat/completions")) return sse(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
    if (path.endsWith("/messages")) return sse(events([{ type: "message_start", message: { usage: { input_tokens: 1 } } }, { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }, { type: "content_block_stop", index: 0 }, { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }, { type: "message_stop" }]));
    return sse(events([{ type: "response.output_text.delta", delta: "ok" }, { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } }]));
  } });
});
afterAll(() => server.stop(true));

const base = (): string => `http://127.0.0.1:${server.port}/v1`;
const request = (effort?: ModelRequest["effort"]): ModelRequest => ({ system: "s", messages: [{ role: "user", content: "hi" }], tools: [], ...(effort ? { effort } : {}) });
const ignore: StreamHandlers = { text: () => undefined, thought: () => undefined, toolStarted: () => undefined };
const bodyOf = async (p: Provider, effort?: ModelRequest["effort"]): Promise<any> => { seen = []; await p.stream(request(effort), new AbortController().signal, ignore); return seen[0]!.body; };

describe("each API gets the effort in its own shape, and Auto sends nothing", () => {
  test("the messages API: output_config.effort, with every level it has; minimal is the lowest it knows", async () => {
    const p = new MessagesApiProvider({ baseUrl: base(), model: "m", apiKey: "k" });
    for (const level of ["low", "medium", "high", "xhigh", "max"] as const) expect((await bodyOf(p, level)).output_config).toEqual({ effort: level });
    expect((await bodyOf(p, "minimal")).output_config).toEqual({ effort: "low" });
    const auto = await bodyOf(p);
    expect(auto).not.toHaveProperty("output_config");
    expect(JSON.stringify(auto)).not.toMatch(/effort|reasoning/);
  });

  test("chat completions: reasoning_effort, or a reasoning object where the service wants that; never when the model is marked as taking none", async () => {
    const plain = new ChatCompletionsProvider({ baseUrl: base(), model: "m" });
    expect((await bodyOf(plain, "high")).reasoning_effort).toBe("high");
    expect(await bodyOf(plain, "high")).not.toHaveProperty("reasoning");
    const nested = new ChatCompletionsProvider({ baseUrl: base(), model: "m", effortField: "reasoning" });
    const b = await bodyOf(nested, "xhigh");
    expect(b.reasoning).toEqual({ effort: "xhigh" });
    expect(b).not.toHaveProperty("reasoning_effort");
    expect(await bodyOf(new ChatCompletionsProvider({ baseUrl: base(), model: "m", reasoning: "none" }), "high")).not.toHaveProperty("reasoning_effort");
    for (const p of [plain, nested]) expect(JSON.stringify(await bodyOf(p))).not.toMatch(/effort|reasoning/);
  });

  test("the responses API: reasoning.effort, the level it has nearest to the one chosen; Auto sends no reasoning field", async () => {
    const p = new ResponsesApiProvider({ baseUrl: base(), model: "m", apiKey: "k" });
    expect((await bodyOf(p, "low")).reasoning.effort).toBe("low");
    expect((await bodyOf(p, "xhigh")).reasoning.effort).toBe("high");
    expect(await bodyOf(p)).not.toHaveProperty("reasoning");
  });
});

describe("a server that does not know the effort field", () => {
  const refuse = (message: string) => (_path: string, body: any): Response | undefined =>
    body.reasoning_effort || body.output_config || body.reasoning ? new Response(JSON.stringify({ error: { message } }), { status: 400, headers: { "content-type": "application/json" } }) : undefined;

  test("the same request goes again without it, once; the model is then taken as one with no effort, the person is told in one sentence, and later requests carry none", async () => {
    answer = refuse("Unknown parameter: 'reasoning_effort'.");
    seen = [];
    const r = rig(() => ({ text: "x" }), {
      provider: new ChatCompletionsProvider({ baseUrl: base(), model: "m" }), efforts: ["low", "medium", "high"],
    });
    expect(r.of("caps").at(-1)!.efforts).toEqual(["low", "medium", "high"]);
    r.send({ cmd: "effort", level: "high" });
    await r.turn(prompt("hello"));
    expect(seen.map((s) => "reasoning_effort" in s.body)).toEqual([true, false]);
    expect(r.of("text").map((e) => e.text).join("")).toBe("ok");
    expect(r.of("notice").map((e) => e.msg)).toEqual(["This model does not take an effort setting, so it runs on Auto."]);
    expect(r.of("error")).toEqual([]);
    expect(r.of("caps").at(-1)!.efforts).toBeUndefined();
    expect(r.of("caps").at(-1)!.effort).toBeUndefined();
    seen = [];
    await r.turn(prompt("again"));
    expect(seen).toHaveLength(1);
    expect(seen[0]!.body).not.toHaveProperty("reasoning_effort");
    r.send({ cmd: "effort", level: "high" });
    expect(r.of("error").at(-1)!.msg).toBe("This model has no effort setting.");
    r.cleanup();
    answer = () => undefined;
  });

  test("only a 400 about the field counts: another 400, another status and a request that sent no effort are errors as before", async () => {
    for (const [status, message, withEffort] of [[400, "messages: first message must be from the user", true], [401, "the key is not accepted", true], [400, "Unknown parameter: 'reasoning_effort'.", false]] as const) {
      answer = () => new Response(JSON.stringify({ error: { message } }), { status });
      seen = [];
      const r = rig(() => ({ text: "x" }), { provider: new ChatCompletionsProvider({ baseUrl: base(), model: "m" }), efforts: ["low", "high"] });
      if (withEffort) r.send({ cmd: "effort", level: "high" });
      await r.turn(prompt("hello"));
      expect(r.of("error")).toHaveLength(1);
      expect(r.of("notice").filter((e) => /effort/.test(e.msg))).toEqual([]);
      expect(seen).toHaveLength(1);
      r.cleanup();
    }
    answer = () => undefined;
  });

  test("it works for the other two shapes as well, and the retry is not tried a second time when the plain request is refused too", async () => {
    for (const [make, message] of [[() => new MessagesApiProvider({ baseUrl: base(), model: "m", apiKey: "k" }), "output_config.effort: Extra inputs are not permitted"], [() => new ResponsesApiProvider({ baseUrl: base(), model: "m", apiKey: "k" }), "Unsupported parameter: 'reasoning.effort'"]] as const) {
      answer = refuse(message);
      seen = [];
      const r = rig(() => ({ text: "x" }), { provider: make(), efforts: ["low", "high"] });
      r.send({ cmd: "effort", level: "low" });
      await r.turn(prompt("hello"));
      expect(seen).toHaveLength(2);
      expect(r.of("text").map((e) => e.text).join("")).toBe("ok");
      r.cleanup();
    }
    answer = () => new Response(JSON.stringify({ error: { message: "Unknown parameter: 'reasoning_effort'." } }), { status: 400 });
    seen = [];
    const r = rig(() => ({ text: "x" }), { provider: new ChatCompletionsProvider({ baseUrl: base(), model: "m" }), efforts: ["low", "high"] });
    r.send({ cmd: "effort", level: "low" });
    await r.turn(prompt("hello"));
    expect(seen).toHaveLength(2);
    expect(r.of("error")).toHaveLength(1);
    r.cleanup();
    answer = () => undefined;
  });
});
