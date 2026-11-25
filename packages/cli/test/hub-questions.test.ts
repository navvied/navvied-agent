import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHub } from "../src/commands/hub.ts";
import { fakeIO, remove, tempDir, until } from "./helpers.ts";

const dirs: string[] = [];
let server: ReturnType<typeof Bun.serve>;
beforeAll(() => {
  server = Bun.serve({ port: 0, async fetch(req) {
    const body = (await req.json()) as { messages: { role: string; content: unknown }[]; stream?: boolean };
    if (!body.stream) return Response.json({ choices: [{ message: { content: "t" } }] });
    const results = body.messages.filter((m) => m.role === "tool");
    const chunk = (delta: object, finish?: string) => `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish ?? null }], usage: { total_tokens: 10, prompt_tokens: 5, completion_tokens: 5 } })}\n\n`;
    const call = { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "AskUserQuestion", arguments: JSON.stringify({ questions: [{ question: "Which port?", choices: ["80", "8080"] }] }) } }] };
    const out = results.length ? chunk({ content: `heard: ${String(results[0]!.content)}` }) + chunk({}, "stop") : chunk(call) + chunk({}, "tool_calls");
    return new Response(`${out}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
});
afterAll(() => { server.stop(true); dirs.forEach(remove); });

type Ev = { ev: string; [k: string]: unknown };
function open(window: { answers?: true }) {
  const state = tempDir(), work = tempDir();
  dirs.push(state, work);
  const env = { HOME: state, XDG_STATE_HOME: state, NAVVIED_BASE_URL: `http://127.0.0.1:${server.port}/v1`, NAVVIED_MODEL: "m", NAVVIED_WINDOW: "100000" };
  const hub = createHub({ json: false, yes: false, thinking: false, cwd: work } as never, fakeIO({ env }).io, { watch: false });
  const got: Ev[] = [];
  hub.attach({ send: (line) => { got.push(JSON.parse(String(line))); }, ...window }, 0);
  const send = (cmd: object): void => hub.command(JSON.stringify(cmd), () => undefined);
  return { hub, got, send };
}

describe("the agent's questions through a hub", () => {
  test("a window that can answer is asked, and its answer reaches the agent", async () => {
    const { hub, got, send } = open({ answers: true });
    send({ cmd: "prompt", text: "set it up", qid: "a1" });
    await until(() => got.some((e) => e.ev === "question"));
    expect(got.find((e) => e.ev === "caps")).toMatchObject({ questions: true });
    const q = got.find((e) => e.ev === "question") as unknown as { id: string; questions: unknown[] };
    expect(q.questions).toEqual([{ question: "Which port?", choices: ["80", "8080"] }]);
    send({ cmd: "answer", id: q.id, answers: [["80"]] });
    await until(() => got.some((e) => e.ev === "done"));
    expect(got.filter((e) => e.ev === "text").map((e) => e.text).join("")).toContain('heard: Which port? -> "80"');
    await hub.stop();
  });

  test("a window that has not said it can answer is not asked: the agent is told nobody can, and goes on", async () => {
    const { hub, got, send } = open({});
    send({ cmd: "prompt", text: "set it up", qid: "a1" });
    await until(() => got.some((e) => e.ev === "done"));
    expect(got.some((e) => e.ev === "question")).toBe(false);
    expect(got.filter((e) => e.ev === "text").map((e) => e.text).join("")).toContain("Nobody can answer now");
    await hub.stop();
  });
});
