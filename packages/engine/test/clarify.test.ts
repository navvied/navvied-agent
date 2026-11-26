import { afterAll, describe, expect, test } from "bun:test";
import { NOBODY_ANSWERS } from "../src/questions.ts";
import { HOOK_MS, cleanupAll, prompt, rig, until } from "./helpers.ts";
import type { ModelRequest } from "../src/types.ts";

afterAll(cleanupAll, HOOK_MS);

const toolResults = (req: ModelRequest): string[] => req.messages.filter((m) => m.role === "tool").map((m) => String(m.content));
const asking = (args: unknown) => (req: ModelRequest) => (toolResults(req).length ? { text: `ok: ${toolResults(req).at(-1)}` } : { calls: [{ name: "AskUserQuestion", args }] });

describe("AskUserQuestion", () => {
  test("a window that is attached is asked, and the answer is what the model reads", async () => {
    const r = rig(asking({ questions: [{ question: "Which database?", choices: ["Postgres", "SQLite"] }, { question: "Which parts?", choices: ["api", "web"], multi: true }] }), { attended: () => true });
    expect(r.of("caps")[0]).toMatchObject({ questions: true });
    r.send(prompt("set up the store"));
    await until(() => r.of("question").length === 1);
    const q = r.of("question")[0]!;
    expect(q.questions).toEqual([{ question: "Which database?", choices: ["Postgres", "SQLite"] }, { question: "Which parts?", choices: ["api", "web"], multi: true }]);
    expect(r.of("tool").find((e) => e.id === q.tool)?.name).toBe("AskUserQuestion");
    r.send({ cmd: "answer", id: q.id, answers: [["SQLite"], ["api", "web"]] });
    await r.engine.idle();
    expect(toolResults(r.provider.requests.at(-1)!).at(-1)).toBe('Which database? -> "SQLite"\nWhich parts? -> "api, web"');
    r.cleanup();
  });

  test("a question the person skipped is told as such, and one in their own words is kept as written", async () => {
    const r = rig(asking({ questions: [{ question: "A?" }, { question: "B?", choices: ["x"] }] }), { attended: () => true });
    r.send(prompt("go"));
    await until(() => r.of("question").length === 1);
    r.send({ cmd: "answer", id: r.of("question")[0]!.id, answers: [[], ["something else entirely"]] });
    await r.engine.idle();
    expect(toolResults(r.provider.requests.at(-1)!).at(-1)).toBe('A? -> (no answer)\nB? -> "something else entirely"');
    r.cleanup();
  });

  test("with nobody to answer the call does not wait: the model is told to assume and go on", async () => {
    const r = rig(asking({ questions: [{ question: "Which?", choices: ["a"] }] }));
    await r.turn(prompt("go"));
    expect(r.of("question")).toHaveLength(0);
    expect(toolResults(r.provider.requests.at(-1)!)[0]).toBe(NOBODY_ANSWERS);
    r.cleanup();
  });

  test("a helper cannot ask: the tool is not offered to it", async () => {
    const seen: ModelRequest[] = [];
    const r = rig((req) => {
      if (req.tools.some((t) => t.name === "Agent")) return toolResults(req).length ? { text: "done" } : { calls: [{ name: "Agent", args: { prompt: "look" } }] };
      seen.push(req);
      return { text: "looked" };
    }, { attended: () => true });
    await r.turn(prompt("go"));
    expect(seen[0]!.tools.map((t) => t.name)).not.toContain("AskUserQuestion");
    r.cleanup();
  });

  test("when nobody answers in the time given, the model goes on; an answer that comes later reaches it as a message", async () => {
    const r = rig((req) => {
      const results = toolResults(req);
      if (!results.length) return { calls: [{ name: "AskUserQuestion", args: { questions: [{ question: "Which port?" }] } }] };
      if (req.messages.at(-1)?.role === "user") return { text: "using the answer" };
      return { text: "assumed" };
    }, { attended: () => true, askWaitMs: 30 });
    await r.turn(prompt("go"));
    expect(toolResults(r.provider.requests.at(-1)!)[0]).toStartWith("No answer came in time.");
    const id = r.of("question")[0]!.id;
    const before = r.provider.requests.length;
    r.send({ cmd: "answer", id, answers: [["8080"]] });
    await until(() => r.provider.requests.length > before);
    await r.engine.idle();
    expect(String(r.provider.requests.at(-1)!.messages.at(-1)!.content)).toBe('You asked, and the person has answered now:\nWhich port? -> "8080"');
    r.send({ cmd: "answer", id, answers: [["again"]] });
    expect(r.provider.requests.length).toBe(before + 1);
    r.cleanup();
  });

  test("a page cannot make the model ask without end: three questions a turn", async () => {
    const r = rig((req) => (toolResults(req).length >= 4 ? { text: "end" } : { calls: [{ name: "AskUserQuestion", args: { questions: [{ question: `q${toolResults(req).length}?` }] } }] }), { attended: () => true });
    r.send(prompt("go"));
    for (let i = 1; i <= 3; i++) { await until(() => r.of("question").length === i); r.send({ cmd: "answer", id: r.of("question")[i - 1]!.id, answers: [["yes"]] }); }
    await r.engine.idle();
    expect(r.of("question")).toHaveLength(3);
    expect(toolResults(r.provider.requests.at(-1)!)[3]).toStartWith("You have asked enough");
    r.cleanup();
  });

  test("cancel ends a question that waits", async () => {
    const r = rig(asking({ questions: [{ question: "Which?" }] }), { attended: () => true });
    r.send(prompt("go"));
    await until(() => r.of("question").length === 1);
    r.send({ cmd: "cancel" });
    await r.engine.idle();
    expect(r.of("done").at(-1)!.stop).toBe("cancelled");
    r.cleanup();
  });

  test("a lone question as text, choices as words, more than four of them and a call with no question are all handled", async () => {
    const r = rig(asking({ questions: "Which colour?" }), { attended: () => true });
    r.send(prompt("go"));
    await until(() => r.of("question").length === 1);
    expect(r.of("question")[0]!.questions).toEqual([{ question: "Which colour?" }]);
    r.send({ cmd: "answer", id: r.of("question")[0]!.id, answers: [["red"]] });
    await r.engine.idle();
    const many = rig(asking({ questions: [{ question: "Pick", options: [{ label: "a" }, "b", "c", "d", "e"] }] }), { attended: () => true });
    many.send(prompt("go"));
    await until(() => many.of("question").length === 1);
    expect(many.of("question")[0]!.questions[0]!.choices).toEqual(["a", "b", "c", "d"]);
    many.send({ cmd: "cancel" });
    const none = rig(asking({ questions: [] }), { attended: () => true });
    await none.turn(prompt("go"));
    expect(toolResults(none.provider.requests.at(-1)!)[0]).toStartWith("Error: AskUserQuestion needs questions");
    for (const x of [r, many, none]) x.cleanup();
  });
});
