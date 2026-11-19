import { describe, expect, test } from "bun:test";
import { CodexTranslator, friendlyFailure } from "../src/codex-translate.ts";

const run = (lines: object[], window = 200_000) => {
  const t = new CodexTranslator(window);
  return { t, events: lines.flatMap((l) => t.feed(l)) };
};

describe("the Codex event stream, as protocol events", () => {
  test("a plain turn: the thread, the answer as one message, the usage, and the end", () => {
    const { t, events } = run([
      { type: "thread.started", thread_id: "T-1" },
      { type: "turn.started" },
      { type: "item.completed", item: { id: "i0", type: "agent_message", text: "Hello there." } },
      { type: "turn.completed", usage: { input_tokens: 1200, cached_input_tokens: 800, output_tokens: 30 } },
    ]);
    expect(t.threadId).toBe("T-1");
    expect(events).toEqual([
      { ev: "session", id: "T-1" },
      { ev: "text", text: "Hello there.\n" },
      { ev: "usage", ctx: 1200, win: 200_000, out: 30 },
      { ev: "done", stop: "end_turn" },
    ]);
  });

  test("a command is a running row, then a finished one with its output and exit code; a failing one is an error", () => {
    const { events } = run([
      { type: "item.started", item: { id: "c1", type: "command_execution", command: "ls -la", status: "in_progress" } },
      { type: "item.completed", item: { id: "c1", type: "command_execution", command: "ls -la", aggregated_output: "a.txt\n", exit_code: 0, status: "completed" } },
      { type: "item.started", item: { id: "c2", type: "command_execution", command: "false" } },
      { type: "item.completed", item: { id: "c2", type: "command_execution", command: "false", aggregated_output: "", exit_code: 1, status: "failed" } },
    ]);
    expect(events).toEqual([
      { ev: "tool", id: "c1", name: "Bash", status: "running", input: { command: "ls -la" } },
      { ev: "tool", id: "c1", name: "Bash", status: "done", output: "a.txt\n\n[exit 0]" },
      { ev: "tool", id: "c2", name: "Bash", status: "running", input: { command: "false" } },
      { ev: "tool", id: "c2", name: "Bash", status: "error", output: "[exit 1]" },
    ]);
  });

  test("a tool that is only ever seen finishing still gets its row, and long output is cut from the front", () => {
    const { events } = run([{ type: "item.completed", item: { id: "c9", type: "command_execution", command: "make", aggregated_output: `${"x".repeat(9000)}END`, exit_code: 0 } }]);
    expect(events[0]).toMatchObject({ ev: "tool", id: "c9", status: "running" });
    const done = events[1] as { output: string };
    expect(done.output.length).toBeLessThan(4100);
    expect(done.output.endsWith("END\n[exit 0]")).toBe(true);
  });

  test("file changes, reasoning, searches and other tools are each shown in their own way", () => {
    const { events } = run([
      { type: "item.completed", item: { id: "f1", type: "file_change", status: "completed", changes: [{ path: "a.ts", kind: "update" }, { path: "b.ts", kind: "add" }] } },
      { type: "item.completed", item: { id: "r1", type: "reasoning", text: "Let me think." } },
      { type: "item.started", item: { id: "w1", type: "web_search", query: "bun test" } },
      { type: "item.completed", item: { id: "w1", type: "web_search", query: "bun test" } },
      { type: "item.started", item: { id: "m1", type: "mcp_tool_call", server: "docs", tool: "lookup", arguments: { q: 1 } } },
      { type: "item.completed", item: { id: "m1", type: "mcp_tool_call", server: "docs", tool: "lookup", status: "completed", result: { ok: true } } },
    ]);
    expect(events).toEqual([
      { ev: "tool", id: "f1", name: "Edit", status: "done", input: { paths: ["a.ts", "b.ts"] }, output: "update a.ts\nadd b.ts" },
      { ev: "thought", text: "Let me think." },
      { ev: "tool", id: "w1", name: "WebSearch", status: "running", input: { query: "bun test" } },
      { ev: "tool", id: "w1", name: "WebSearch", status: "done", output: "" },
      { ev: "tool", id: "m1", name: "docs:lookup", status: "running", input: { q: 1 } },
      { ev: "tool", id: "m1", name: "docs:lookup", status: "done", output: '{"ok":true}' },
    ]);
  });

  test("the task list becomes the plan, as it is updated and when it is finished", () => {
    const items = [{ text: "Read the code", completed: true }, { text: "Fix the bug", completed: false }];
    const { events } = run([{ type: "item.updated", item: { id: "t", type: "todo_list", items } }, { type: "item.completed", item: { id: "t", type: "todo_list", items } }]);
    const entries = [{ title: "Read the code", status: "completed" }, { title: "Fix the bug", status: "pending" }];
    expect(events).toEqual([{ ev: "plan", entries }, { ev: "plan", entries }]);
  });

  test("a failed turn says so in plain words and ends; the transient 'reconnecting' errors are not shown", () => {
    const { events } = run([
      { type: "error", message: "Reconnecting... 2/5 (unexpected status 401 Unauthorized)" },
      { type: "item.completed", item: { id: "e", type: "error", message: "Falling back from WebSockets" } },
      { type: "turn.failed", error: { message: "unexpected status 401 Unauthorized: Missing bearer or basic authentication" } },
    ]);
    expect(events).toEqual([{ ev: "error", msg: "Codex is not signed in. Use /model to sign in again." }, { ev: "done", stop: "error" }]);
  });

  test("other failures are shown as the program said them, on one line, and not endlessly long", () => {
    expect(friendlyFailure("the model\n  is overloaded")).toBe("the model is overloaded");
    expect(friendlyFailure("x".repeat(500)).length).toBe(300);
    expect(friendlyFailure("Please sign in")).toBe("Codex is not signed in. Use /model to sign in again.");
  });

  test("anything it does not know is ignored, and garbage never throws", () => {
    const t = new CodexTranslator(1);
    for (const junk of [null, 5, "text", [], {}, { type: 7 }, { type: "item.completed" }, { type: "item.completed", item: { type: "agent_message" } }, { type: "thread.started" }, { type: "new.thing", x: 1 }]) {
      expect(() => t.feed(junk)).not.toThrow();
    }
    expect(t.feed({ type: "thread.started" })).toEqual([]);
  });
});
