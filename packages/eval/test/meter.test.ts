import { afterAll, describe, expect, test } from "bun:test";
import { startMeter } from "../src/index.ts";

const enc = new TextEncoder();
const sse = (events: string[]): Response => new Response(new ReadableStream({ start(c) { for (const e of events) c.enqueue(enc.encode(`${e}\n\n`)); c.close(); } }), { headers: { "content-type": "text/event-stream" } });

let upstream: (path: string, body: any) => Response | Promise<Response> = () => new Response("{}");
const seen: { path: string; auth: string | null; body: any }[] = [];
const model = Bun.serve({
  port: 0,
  async fetch(req) {
    const raw = await req.text();
    const body = raw ? JSON.parse(raw) : undefined;
    seen.push({ path: new URL(req.url).pathname, auth: req.headers.get("authorization"), body });
    return upstream(new URL(req.url).pathname, body);
  },
});
const meter = startMeter(`http://127.0.0.1:${model.port}/v1`);
afterAll(() => { meter.stop(); model.stop(true); });

const chatRequest = { model: "m", stream: true, messages: [{ role: "system", content: "You are brief." }, { role: "user", content: "hello" }], tools: [{ type: "function", function: { name: "Bash", description: "Run it", parameters: { type: "object", properties: {} } } }] };
const post = (run: string, path: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${meter.url(run)}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

describe("the counter, chat completions", () => {
  test("passes a streamed answer on whole and counts the tokens the answer says it used, and the weight of the request", async () => {
    upstream = () => sse([`data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}`, `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 123, completion_tokens: 7 } })}`, "data: [DONE]"]);
    const before = Date.now();
    const res = await post("r1", "/chat/completions", chatRequest, { authorization: "Bearer key-1" });
    const body = await res.text();
    expect(body).toContain('"content":"hi"');
    expect(body).toContain("[DONE]");
    expect(seen.at(-1)).toMatchObject({ path: "/v1/chat/completions", auth: "Bearer key-1" });
    expect(seen.at(-1)!.body).toEqual(chatRequest);
    const [hit, ...rest] = await meter.take("r1");
    expect(rest).toEqual([]);
    expect(hit).toMatchObject({ path: "/chat/completions".replace(/^/, "/v1"), stream: true, inTokens: 123, outTokens: 7, estimated: false, status: 200, systemChars: "You are brief.".length, tools: 1, messages: 2 });
    expect(hit!.toolChars).toBe(JSON.stringify(chatRequest.tools).length);
    expect(hit!.requestBytes).toBe(JSON.stringify(chatRequest).length);
    expect(hit!.at).toBeGreaterThanOrEqual(before);
  });

  test("an answer that is not a stream is counted too, and one without token counts is estimated, and said to be", async () => {
    upstream = () => Response.json({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 50, completion_tokens: 2 } });
    await post("r2", "/chat/completions", { ...chatRequest, stream: false });
    upstream = () => Response.json({ choices: [{ message: { content: "ok" } }] });
    await post("r2", "/chat/completions", { ...chatRequest, stream: false });
    const [a, b] = await meter.take("r2");
    expect(a).toMatchObject({ inTokens: 50, outTokens: 2, estimated: false, stream: false });
    expect(b).toMatchObject({ outTokens: 0, estimated: true });
    expect(b!.inTokens).toBe(Math.ceil(JSON.stringify({ ...chatRequest, stream: false }).length / 4));
  });
});

describe("the counter, messages", () => {
  test("reads the tokens of the events of a stream, and the system text and tools of that protocol", async () => {
    upstream = () => sse([
      `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 400, output_tokens: 1 } } })}`,
      `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 42 } })}`,
    ]);
    const request = { model: "m", stream: true, system: [{ type: "text", text: "Be careful." }], messages: [{ role: "user", content: "hi" }], tools: [{ name: "Bash", description: "Run", input_schema: { type: "object" } }] };
    await (await post("r3", "/messages", request)).text();
    const [hit] = await meter.take("r3");
    expect(hit).toMatchObject({ inTokens: 400, outTokens: 42, estimated: false, systemChars: "Be careful.".length, tools: 1, messages: 1 });
  });
});

describe("the counter, in general", () => {
  test("runs are kept apart, and a run that is taken is forgotten", async () => {
    upstream = () => Response.json({ usage: { prompt_tokens: 1, completion_tokens: 1 } });
    await post("one", "/chat/completions", { ...chatRequest, stream: false });
    await post("two", "/chat/completions", { ...chatRequest, stream: false });
    await post("two", "/chat/completions", { ...chatRequest, stream: false });
    expect((await meter.take("one")).length).toBe(1);
    expect((await meter.take("two")).length).toBe(2);
    expect(await meter.take("one")).toEqual([]);
  });
  test("what is not a model request is passed on untouched and not counted", async () => {
    upstream = (path) => Response.json({ path });
    const res = await fetch(`${meter.url("misc")}/models`);
    expect(await res.json()).toEqual({ path: "/v1/models" });
    expect(await meter.take("misc")).toEqual([]);
  });
  test("a model that cannot be reached is a 502 with a sentence, and is counted as a call that failed", async () => {
    const lost = startMeter("http://127.0.0.1:1/v1");
    const res = await fetch(`${lost.url("x")}/chat/completions`, { method: "POST", body: JSON.stringify(chatRequest) });
    expect(res.status).toBe(502);
    expect(await res.text()).toContain("could not reach the model");
    expect((await lost.take("x"))[0]).toMatchObject({ status: 502, estimated: true });
    lost.stop();
  });
  test("the model's own refusal is passed on as it is", async () => {
    upstream = () => new Response("slow down", { status: 429 });
    const res = await post("r4", "/chat/completions", { ...chatRequest, stream: false });
    expect(res.status).toBe(429);
    expect(await res.text()).toBe("slow down");
    expect((await meter.take("r4"))[0]).toMatchObject({ status: 429 });
  });
  test("an address that is not a run of the counter is refused", async () => {
    expect((await fetch(`http://127.0.0.1:${meter.port}/v1/chat/completions`, { method: "POST", body: "{}" })).status).toBe(404);
  });
});
