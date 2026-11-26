import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { EngineEvent } from "@navvied/protocol";
import { answeredLines, askQuestions } from "../src/question-ui.ts";
import type { Choice, IO } from "../src/io.ts";
import { parseArgs } from "../src/args.ts";
import { main } from "../src/main.ts";
import { fakeIO, remove, tempDir } from "./helpers.ts";

type Asked = Extract<EngineEvent, { ev: "question" }>;

/** A fake terminal that picks the rows named in order (a name that is not there picks nothing) and types what it is told. */
function terminal(picks: (string | undefined)[], typed: string[] = []) {
  const shown: string[][] = [];
  const frames: { title: string; body?: string[] }[] = [];
  const io = {
    color: false,
    choose: async (title: string, items: Choice[], _at: number, frame: { body?: string[] }): Promise<number | undefined> => { frames.push({ title, ...(frame.body ? { body: frame.body } : {}) }); shown.push(items.map((i) => i.label)); const want = picks.shift(); const at = items.findIndex((i) => i.label === want); return at < 0 ? undefined : at; },
    text: async (): Promise<string | undefined> => typed.shift(),
  } as unknown as IO;
  return { io, shown, frames };
}
const asked = (...questions: Asked["questions"]): Asked => ({ ev: "question", id: "q1", questions });

describe("the questions of the agent in the terminal", () => {
  test("a choice is picked from a list, and the person's own words are the last row", async () => {
    const { io, shown } = terminal(["SQLite", "In my own words…"], ["Mongo"]);
    expect(await askQuestions(io, asked({ question: "Which?", choices: ["Postgres", "SQLite"] }, { question: "And?", choices: ["x"] }))).toEqual([["SQLite"], ["Mongo"]]);
    expect(shown[0]).toEqual(["Postgres", "SQLite", "In my own words…"]);
  });
  test("every list is titled the same and carries the question under it", async () => {
    const { io, frames } = terminal(["x"]);
    await askQuestions(io, asked({ question: "Which?", choices: ["x"] }));
    expect(frames).toEqual([{ title: "A question", body: ["", "Which?"] }]);
  });
  test("the conversation keeps the answered questions and says the agent goes on; nothing when all were skipped", () => {
    const e = asked({ question: "Which?", choices: ["a"] }, { question: "And?" });
    expect(answeredLines(false, e, [["a", "b"], []])).toEqual(["Which?", "● a", "● b", "", "Answered. navvied is continuing."]);
    expect(answeredLines(false, e, [[], []])).toEqual([]);
  });
  test("several can be picked from one list until the person says done", async () => {
    const { io, shown } = terminal(["a", "c", "Done"]);
    expect(await askQuestions(io, asked({ question: "Which?", choices: ["a", "b", "c"], multi: true }))).toEqual([["a", "c"]]);
    expect(shown[1]).toEqual(["b", "c", "In my own words…", "Done"]);
  });
  test("leaving the list skips that question and the rest", async () => {
    const { io } = terminal([undefined]);
    expect(await askQuestions(io, asked({ question: "A?", choices: ["x"] }, { question: "B?", choices: ["y"] }))).toEqual([[], []]);
  });
  test("an empty own answer asks the list again; a terminal with no menus skips everything", async () => {
    const { io } = terminal(["In my own words…", "x"], [" "]);
    expect(await askQuestions(io, asked({ question: "A?", choices: ["x"] }))).toEqual([["x"]]);
    expect(await askQuestions({ color: false } as unknown as IO, asked({ question: "A?" }, { question: "B?" }))).toEqual([[], []]);
  });
});

describe("--answers", () => {
  test("a list of words, or of lists of words, and nothing else", () => {
    expect(parseArgs(["run", "x", "--answers", '["a",["b","c"]]'])).toMatchObject({ ok: true, options: { answers: [["a"], ["b", "c"]] } });
    for (const bad of ["nope", '{"a":1}', "[1]", '[["a",2]]']) expect(parseArgs(["run", "x", "--answers", bad])).toMatchObject({ ok: false });
  });
});

const dirs: string[] = [];
const requests: { role: string; content: unknown }[][] = [];
let server: ReturnType<typeof Bun.serve>;
beforeAll(() => {
  server = Bun.serve({ port: 0, async fetch(req) {
    const body = (await req.json()) as { messages: { role: string; content: unknown }[] };
    requests.push(body.messages);
    const results = body.messages.filter((m) => m.role === "tool");
    const chunk = (delta: object, finish?: string) => `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish ?? null }], usage: { total_tokens: 10, prompt_tokens: 5, completion_tokens: 5 } })}\n\n`;
    const call = { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "AskUserQuestion", arguments: JSON.stringify({ questions: [{ question: "Which port?", choices: ["80", "8080"] }] }) } }] };
    const text = results.length ? `heard: ${String(results[0]!.content)}` : undefined;
    return new Response((text ? chunk({ content: text }) + chunk({}, "stop") : chunk(call) + chunk({}, "tool_calls")) + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  } });
});
afterAll(() => { server.stop(true); dirs.forEach(remove); });

async function run(args: string[]) {
  const dir = tempDir(); dirs.push(dir);
  const env = { HOME: dir, XDG_STATE_HOME: dir, NAVVIED_BASE_URL: `http://127.0.0.1:${server.port}/v1`, NAVVIED_MODEL: "m", NAVVIED_WINDOW: "100000" };
  const f = fakeIO({ env });
  requests.length = 0;
  const code = await main(["run", "set it up", "--last", ...args, "--cwd", dir], f.io);
  return { code, out: f.out() };
}

describe("navvied run and the agent's questions", () => {
  test("scripted answers reach the agent as the person's choice", async () => {
    const r = await run(["--answers", '["8080"]']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('heard: Which port? -> "8080"');
  });
  test("without them nobody can answer: the agent is told to assume and go on, at once", async () => {
    const r = await run([]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Nobody can answer now: pick the most reasonable option, say what you assumed, and do the work.");
  });
});
