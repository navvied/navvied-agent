import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelRequest } from "../src/types.ts";
import { HOOK_MS, cleanupAll, prompt, rig } from "./helpers.ts";

afterAll(cleanupAll, HOOK_MS);

const OPEN = "[The task list still has open steps. Do them, or say what blocks you.]";
const todos = (...items: [string, string][]) => ({ todos: items.map(([content, status]) => ({ content, status })) });
const told = (req: ModelRequest): number => req.messages.filter((m) => m.role === "user" && m.content === OPEN).length;

/** The model of the failure: it writes its list, then ends the turn asking for leave to start. */
const asksLeave = (dir: string) => (req: ModelRequest) => {
  const tools = req.messages.filter((m) => m.role === "tool").length;
  if (tools === 0) return { calls: [{ name: "TodoWrite", args: todos(["Write a.txt", "pending"], ["Write b.txt", "pending"]) }] };
  if (told(req) === 0) return { text: "Shall I go on now?" };
  if (tools === 1) return { calls: [{ name: "Write", args: { file_path: join(dir, "a.txt"), content: "alpha\n" } }] };
  if (tools === 2) return { calls: [{ name: "Write", args: { file_path: join(dir, "b.txt"), content: "beta\n" } }] };
  if (tools === 3) return { calls: [{ name: "TodoWrite", args: todos(["Write a.txt", "completed"], ["Write b.txt", "completed"]) }] };
  return { text: "Done." };
};

describe("a task list that was left open", () => {
  test("the turn is told once, and the work gets done", async () => {
    const r = rig((req, _n, dir) => asksLeave(dir)(req));
    await r.turn(prompt("a.txt alpha b.txt beta, to-do list first"));
    expect(told(r.provider.requests.at(-1)!)).toBe(1);
    expect(existsSync(join(r.dir, "a.txt"))).toBe(true);
    expect(readFileSync(join(r.dir, "b.txt"), "utf8")).toBe("beta\n");
    expect(r.of("done")).toHaveLength(1);
    r.cleanup();
  });

  test("a model that ends again is let go: one note, no loop", async () => {
    const r = rig((req) => (req.messages.some((m) => m.role === "tool") ? { text: "I still want your leave." } : { calls: [{ name: "TodoWrite", args: todos(["a", "pending"]) }] }));
    await r.turn(prompt("go"));
    expect(r.provider.requests).toHaveLength(3);
    expect(told(r.provider.requests.at(-1)!)).toBe(1);
    expect(r.of("done")).toHaveLength(1);
    r.cleanup();
  });

  test("a finished list is not reopened", async () => {
    const r = rig((req) => (req.messages.some((m) => m.role === "tool") ? { text: "all done" } : { calls: [{ name: "TodoWrite", args: todos(["a", "completed"]) }] }));
    await r.turn(prompt("go"));
    expect(r.provider.requests).toHaveLength(2);
    expect(told(r.provider.requests.at(-1)!)).toBe(0);
    r.cleanup();
  });

  test("plan mode is left alone: it only reads and presents", async () => {
    const r = rig((req) => (req.messages.some((m) => m.role === "tool") ? { text: "the plan" } : { calls: [{ name: "TodoWrite", args: todos(["a", "pending"]) }] }));
    await r.turn(prompt("plan it", { mode: "plan" }));
    expect(told(r.provider.requests.at(-1)!)).toBe(0);
    r.cleanup();
  });

  test("a turn in which the model asked the person is not told", async () => {
    const r = rig((req) => {
      const tools = req.messages.filter((m) => m.role === "tool").length;
      if (tools === 0) return { calls: [{ name: "TodoWrite", args: todos(["a", "pending"]) }] };
      if (tools === 1) return { calls: [{ name: "AskUserQuestion", args: { questions: [{ question: "Which port?" }] } }] };
      return { text: "I need the port." };
    });
    await r.turn(prompt("go"));
    expect(told(r.provider.requests.at(-1)!)).toBe(0);
    r.cleanup();
  });

  // The other reason to send a turn back is an offer after a question: the two share the turn's one note.
  test("one turn is sent back once, whatever the reason: after the open list, an offer after a question is let go", async () => {
    const r = rig((req) => {
      const tools = req.messages.filter((m) => m.role === "tool").length;
      if (tools === 0) return { calls: [{ name: "TodoWrite", args: todos(["a", "pending"]) }] };
      if (told(req) === 0) return { text: "Shall I start?" };
      return tools === 1 ? { calls: [{ name: "AskUserQuestion", args: { questions: [{ question: "Which?" }] } }] } : { text: "If you want, I can do it." };
    });
    await r.turn(prompt("go"));
    const last = r.provider.requests.at(-1)!;
    expect(r.provider.requests).toHaveLength(4);
    expect(last.messages.filter((m) => m.role === "user" && String(m.content).startsWith("[")).map((m) => m.content)).toEqual([OPEN]);
    expect(r.of("done")).toHaveLength(1);
    r.cleanup();
  });

  test("the note is in the messages, not in the system prompt or the tools", async () => {
    const r = rig((req, _n, dir) => asksLeave(dir)(req));
    await r.turn(prompt("go"));
    const [first, last] = [r.provider.requests[0]!, r.provider.requests.at(-1)!];
    expect(last.system).toBe(first.system);
    expect(JSON.stringify(last.tools)).toBe(JSON.stringify(first.tools));
    expect(last.system).not.toContain("open steps");
    r.cleanup();
  });
});
