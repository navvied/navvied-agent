import { afterAll, describe, expect, test } from "bun:test";
import { STALE_AFTER_STEPS, todo } from "../src/tools/todo.ts";
import type { Message, ModelRequest, SessionStore } from "../src/types.ts";
import { HOOK_MS, cleanupAll, prompt, rig } from "./helpers.ts";

afterAll(cleanupAll, HOOK_MS);

const results = (req: ModelRequest): string[] => req.messages.filter((m) => m.role === "tool").map((m) => String(m.content));
const list = (...items: [string, string, string?][]) => ({ todos: items.map(([content, status, activeForm]) => ({ content, status, ...(activeForm ? { activeForm } : {}) })) });
/** One tool call a step, from a list; then an end. */
const steps = (...calls: { name: string; args: unknown }[]) => (req: ModelRequest) => { const n = results(req).length; return n < calls.length ? { calls: [calls[n]!] } : { text: "end" }; };

describe("TodoWrite", () => {
  test("the list is echoed back compactly, with the present tense for what is running", async () => {
    const r = rig(steps({ name: "TodoWrite", args: list(["Read the code", "completed"], ["Run the tests", "in_progress", "Running the tests"], ["Write the notes", "pending"]) }));
    await r.turn(prompt("1. read\n2. run\n3. write"));
    expect(results(r.provider.requests.at(-1)!)[0]).toBe("Task list updated:\n[x] Read the code\n[>] Running the tests\n[ ] Write the notes");
    expect(r.of("plan")[0]!.entries[1]).toEqual({ title: "Run the tests", status: "in_progress", activeForm: "Running the tests" });
    r.cleanup();
  });

  test("two items in progress are sent back to be fixed, and the list is not kept or shown", async () => {
    const r = rig(steps({ name: "TodoWrite", args: list(["a", "in_progress"], ["b", "in_progress"]) }));
    await r.turn(prompt("go"));
    expect(results(r.provider.requests.at(-1)!)[0]).toMatch(/^Error: 2 items are in_progress \(a; b\)\. Only one at a time/);
    expect(r.of("plan")).toHaveLength(0);
    r.cleanup();
  });

  test("no item in progress while work is left is accepted, with a nudge to start one; a finished list says so", async () => {
    const r = rig(steps({ name: "TodoWrite", args: list(["a", "pending"]) }, { name: "TodoWrite", args: list(["a", "completed"]) }));
    await r.turn(prompt("go"));
    const got = results(r.provider.requests.at(-1)!);
    expect(got[0]).toContain("No item is in_progress");
    expect(got[1]).toEndWith("All done.");
    r.cleanup();
  });

  test("words models use for a state, other names for the list and plain strings are understood", async () => {
    const r = rig(steps({ name: "TodoWrite", args: { items: [{ task: "a", status: "done" }, { title: "b", status: "In Progress" }, "c"] } }));
    await r.turn(prompt("go"));
    expect(r.of("plan")[0]!.entries.map((e) => `${e.title}:${e.status}`)).toEqual(["a:completed", "b:in_progress", "c:pending"]);
    r.cleanup();
  });

  test("an empty list is refused with a call that works", async () => {
    const r = rig(steps({ name: "TodoWrite", args: { todos: [] } }));
    await r.turn(prompt("go"));
    expect(results(r.provider.requests.at(-1)!)[0]).toContain('{"todos": [{"content": "Run the tests", "status": "in_progress"');
    r.cleanup();
  });

  test("after some steps without touching an unfinished list, the next result carries a reminder, once", async () => {
    const calls = [{ name: "TodoWrite", args: list(["a", "in_progress"]) }, ...Array.from({ length: STALE_AFTER_STEPS + 3 }, () => ({ name: "Glob", args: { pattern: "*" } }))];
    const r = rig(steps(...calls));
    await r.turn(prompt("go"));
    const got = results(r.provider.requests.at(-1)!);
    const reminded = got.map((g, i) => (g.includes("[Reminder: your task list") ? i : -1)).filter((i) => i >= 0);
    expect(reminded).toHaveLength(1);
    expect(got[reminded[0]!]).toContain(`${STALE_AFTER_STEPS} steps`);
    r.cleanup();
  });

  test("a finished list is never reminded about", async () => {
    const calls = [{ name: "TodoWrite", args: list(["a", "completed"]) }, ...Array.from({ length: STALE_AFTER_STEPS + 2 }, () => ({ name: "Glob", args: { pattern: "*" } }))];
    const r = rig(steps(...calls));
    await r.turn(prompt("go"));
    expect(results(r.provider.requests.at(-1)!).join("\n")).not.toContain("Reminder");
    r.cleanup();
  });

  test("what is not finished is put back in front of the model when the conversation is summarised", async () => {
    const r = rig(steps({ name: "TodoWrite", args: list(["Done thing", "completed"], ["Open thing", "in_progress", "Doing the open thing"], ["Later thing", "pending"]) }, { name: "Glob", args: { pattern: "*" } }, { name: "Glob", args: { pattern: "*" } }));
    await r.turn(prompt("go"));
    await r.turn({ cmd: "compact" });
    await r.turn(prompt("continue"));
    const first = String(r.provider.requests.at(-1)!.messages[0]!.content);
    expect(first).toContain("SUMMARY of the work so far");
    expect(first).toContain("[Your task list, kept across the summary]\n[>] Doing the open thing\n[ ] Later thing");
    expect(first).not.toContain("Done thing");
    r.cleanup();
  });

  test("a saved conversation that is loaded again has its list back, and is reminded about it", async () => {
    const saved = new Map<string, Message[]>();
    const store: SessionStore = { save: (id, m) => { saved.set(id, structuredClone(m)); }, load: (id) => saved.get(id) ?? null };
    const first = rig(steps({ name: "TodoWrite", args: list(["Open thing", "in_progress"]) }), { store, sessionId: "s1" });
    await first.turn(prompt("go"));
    first.cleanup();
    const calls = Array.from({ length: STALE_AFTER_STEPS + 1 }, () => ({ name: "Glob", args: { pattern: "*" } }));
    const again = rig(steps(...calls), { store, sessionId: "s1" });
    await again.turn(prompt("more"));
    expect(results(again.provider.requests.at(-1)!).join("\n")).toContain("[Reminder: your task list");
    again.cleanup();
  });

  test("it is offered for a long request in any language, and not to a small model", () => {
    const offered = (userText: string, small = false, steps = 0): boolean => todo.offeredWhen!({ small, userText, jobs: 0, steps });
    expect(offered("corrige ce bug dans le fichier ".repeat(20))).toBe(true);
    expect(offered("请修复 ".repeat(150))).toBe(true);
    expect(offered("1. a\n2. b")).toBe(true);
    expect(offered("fix it", false, 4)).toBe(true);
    expect(offered("fix it")).toBe(false);
    expect(offered("1. a\n2. b", true)).toBe(false);
  });

  test("it is offered at the first step when the request has several parts, in any language, and not for one task", () => {
    const offered = (userText: string, small = false): boolean => todo.offeredWhen!({ small, userText, jobs: 0, steps: 0 });
    expect(offered("Fix the login bug, add a test for it, and update the changelog")).toBe(true);
    expect(offered("Rename the module; update the imports; run the tests")).toBe(true);
    expect(offered("修复登录错误，添加一个测试，更新更改日志，然后运行全部测试")).toBe(true);
    expect(offered("The tests in this project fail. Find the bug in the source code and fix it. Do not change the tests.")).toBe(false);
    expect(offered("In app.py, line 3, change the name")).toBe(false);
    expect(offered("Fix the login bug in src/auth.ts and add a test for it")).toBe(false);
    expect(offered("Read https://example.com/a.b/c.d and summarise it")).toBe(false);
    expect(offered("Fix the login bug, add a test, update the changelog", true)).toBe(false);
  });
});
