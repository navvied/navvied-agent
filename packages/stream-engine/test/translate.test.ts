import { describe, expect, test } from "bun:test";
import type { EngineEvent } from "@navvied/protocol";
import { Translator, buildArgv } from "../src/index.ts";

const make = (extra: { now?: () => number; onTaken?: (u: string) => void } = {}) => new Translator({ window: 1000, ...extra });
const feed = (t: Translator, ...lines: unknown[]): EngineEvent[] => lines.flatMap((l) => t.feed(l));

describe("session and phases", () => {
  test("init reports the session once", () => {
    const t = make();
    expect(t.feed({ type: "system", subtype: "init", session_id: "s1" })).toEqual([{ ev: "session", id: "s1" }]);
    expect(t.feed({ type: "system", subtype: "init", session_id: "s1" })).toEqual([]);
    expect(t.sessionId).toBe("s1");
    expect(t.feed({ type: "system", subtype: "init", session_id: "s2" })).toEqual([{ ev: "session", id: "s2" }]);
  });
  test("compaction status becomes a phase", () => {
    const t = make();
    expect(t.feed({ type: "system", subtype: "status", status: "compacting" })).toEqual([{ ev: "phase", name: "compacting" }]);
    expect(t.feed({ type: "system", subtype: "status", status: null })).toEqual([{ ev: "phase", name: "" }]);
    expect(t.feed({ type: "system", subtype: "compact_boundary" })).toEqual([{ ev: "phase", name: "" }]);
  });
  test("housekeeping and junk produce nothing", () => {
    const t = make();
    for (const l of [{ type: "rate_limit_event" }, { type: "system", subtype: "other" }, "text", null, 5, [], {}]) expect(t.feed(l)).toEqual([]);
  });
});

describe("text and reasoning", () => {
  test("streamed pieces are shown once; the whole message that follows is not repeated", () => {
    const t = make();
    const ev = feed(t,
      { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hm" } } },
      { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } } },
      { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } } },
      { type: "assistant", message: { content: [{ type: "text", text: "Hello" }, { type: "thinking", thinking: "hm" }] } },
    );
    expect(ev).toEqual([{ ev: "thought", text: "hm" }, { ev: "text", text: "Hel" }, { ev: "text", text: "lo" }]);
  });
  test("with no streaming, the whole message is shown; the next turn starts fresh", () => {
    const t = make();
    expect(feed(t, { type: "assistant", message: { content: [{ type: "text", text: "whole" }] } })).toEqual([{ ev: "text", text: "whole" }]);
    feed(t, { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } } }, { type: "result", subtype: "success" });
    expect(feed(t, { type: "assistant", message: { content: [{ type: "text", text: "again" }] } })).toEqual([{ ev: "text", text: "again" }]);
  });
  test("empty deltas are dropped", () => {
    expect(make().feed({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "" } } })).toEqual([]);
  });
});

describe("usage", () => {
  test("context is input plus cached tokens; the window comes from the configuration", () => {
    const ev = make().feed({ type: "assistant", message: { content: [], usage: { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 5, output_tokens: 7 } } });
    expect(ev).toEqual([{ ev: "usage", ctx: 115, win: 1000, out: 7 }]);
  });
  test("a message without usage reports none", () => expect(make().feed({ type: "assistant", message: { content: [] } })).toEqual([]));
});

describe("tools", () => {
  test("card appears at the start, gains its input, then its result (array or string content)", () => {
    const t = make();
    const ev = feed(t,
      { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "Bash" } } },
      { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "bad" }] } },
    );
    expect(ev).toEqual([
      { ev: "tool", id: "t1", name: "Bash", status: "running", progress: 0 },
      { ev: "tool", id: "t1", name: "Bash", status: "running", input: { command: "ls" } },
      { ev: "tool", id: "t1", name: "Bash", status: "done", output: "a\nb" },
      { ev: "tool", id: "t1", name: "Bash", status: "error", output: "bad" },
    ]);
  });
  test("input progress is throttled to once a second", () => {
    let now = 5000;
    const t = make({ now: () => now });
    t.feed({ type: "stream_event", event: { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "w", name: "Write" } } });
    const delta = (s: string) => t.feed({ type: "stream_event", event: { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: s } } });
    expect(delta("abc")).toEqual([{ ev: "tool", id: "w", name: "Write", status: "running", progress: 3 }]);
    now += 400; expect(delta("de")).toEqual([]);
    now += 700; expect(delta("f")).toEqual([{ ev: "tool", id: "w", name: "Write", status: "running", progress: 6 }]);
    expect(t.feed({ type: "stream_event", event: { type: "content_block_delta", index: 9, delta: { type: "input_json_delta", partial_json: "x" } } })).toEqual([]);
  });
  test("a result for an unknown tool still renders", () => {
    expect(make().feed({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "zz", content: "r" }] } })).toEqual([{ ev: "tool", id: "zz", name: "tool", status: "done", output: "r" }]);
  });
  test("a sub-agent's steps are children of its call and its text is not shown", () => {
    const ev = feed(make(),
      { type: "assistant", parent_tool_use_id: "task1", message: { content: [{ type: "tool_use", id: "s1", name: "Read", input: { file_path: "a" } }, { type: "text", text: "inner chatter" }] } },
      { type: "user", parent_tool_use_id: "task1", message: { content: [{ type: "tool_result", tool_use_id: "s1", content: "ok" }] } },
    );
    expect(ev).toEqual([
      { ev: "tool", id: "s1", name: "Read", status: "running", input: { file_path: "a" }, parent: "task1" },
      { ev: "tool", id: "s1", name: "Read", status: "done", output: "ok", parent: "task1" },
    ]);
  });
});

describe("plan hand-in", () => {
  test("becomes text plus a proposal; its card and its refusal are hidden", () => {
    const ev = feed(make(),
      { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "p", name: "ExitPlanMode" } } },
      { type: "assistant", message: { content: [{ type: "tool_use", id: "p", name: "ExitPlanMode", input: { plan: "1. a\n2. b" } }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "p", is_error: true, content: "needs approval" }] } },
    );
    expect(ev).toEqual([{ ev: "text", text: "\n\n1. a\n2. b\n" }, { ev: "plan_proposal", id: "p" }]);
  });
});

describe("taken", () => {
  test("the echo of a message maps its uuid back to the client's qid and notifies the engine", () => {
    const seen: string[] = [];
    const t = make({ onTaken: (u) => seen.push(u) });
    t.expect("u1", "q1");
    expect(t.feed({ type: "user", isReplay: true, uuid: "u1", message: {} })).toEqual([{ ev: "taken", qid: "q1" }]);
    expect(t.feed({ type: "user", isReplay: true, uuid: "other", message: {} })).toEqual([]);
    expect(seen).toEqual(["u1", "other"]);
  });
});

describe("end of turn", () => {
  const result = (t: Translator, o: Record<string, unknown>) => t.feed({ type: "result", ...o });
  test("success", () => expect(result(make(), { subtype: "success" })).toEqual([{ ev: "done", stop: "end_turn" }]));
  test("an error result explains itself", () => {
    expect(result(make(), { subtype: "error_max_turns", result: "too many turns" })).toEqual([{ ev: "error", msg: "The agent stopped: too many turns" }, { ev: "done", stop: "error" }]);
    expect(result(make(), { subtype: "success", is_error: true })[0]).toMatchObject({ ev: "error" });
  });
  test("a cancelled turn is not an error", () => {
    const t = make();
    t.interrupting = true;
    expect(result(t, { subtype: "error_during_execution" })).toEqual([{ ev: "done", stop: "cancelled" }]);
    expect(t.interrupting).toBe(false);
  });
  test("an over-long conversation gets a clear message instead of the agent's own text", () => {
    const t = make();
    expect(t.feed({ type: "assistant", message: { content: [{ type: "text", text: "Prompt is too long" }] } })).toEqual([]);
    const ev = result(t, { subtype: "success" });
    expect(ev[0]).toMatchObject({ ev: "error", msg: expect.stringMatching(/no longer fits/) });
    expect(ev[1]).toEqual({ ev: "done", stop: "error" });
    expect(result(t, { subtype: "success" })).toEqual([{ ev: "done", stop: "end_turn" }]); // the flag does not leak into the next turn
  });
});

describe("argv", () => {
  test("model, effort, resume and persona are passed through", () => {
    const a = buildArgv({ command: "agent", args: ["--x"], model: "m", mode: "auto", effort: "high", resume: "sid", persona: "Be brief." });
    expect(a.slice(0, 3)).toEqual(["agent", "--x", "-p"]);
    for (const pair of [["--input-format", "stream-json"], ["--output-format", "stream-json"], ["--model", "m"], ["--effort", "high"], ["--resume", "sid"], ["--append-system-prompt", "Be brief."]]) {
      expect(a[a.indexOf(pair[0]!) + 1]).toBe(pair[1]!);
    }
    for (const f of ["--verbose", "--include-partial-messages", "--replay-user-messages"]) expect(a).toContain(f);
  });
  test("every mode is put to the program the way the mode means: Plan and Bypass by its own modes, the rest by its default mode with navvied deciding in the hook; and only Bypass is no permission prompts at all", () => {
    const permission = (mode: "ask" | "edits" | "plan" | "auto" | "bypass"): string[] => {
      const a = buildArgv({ command: "agent", mode });
      return a.includes("--dangerously-skip-permissions") ? ["--dangerously-skip-permissions"] : ["--permission-mode", a[a.indexOf("--permission-mode") + 1]!];
    };
    expect(permission("ask")).toEqual(["--permission-mode", "default"]);
    expect(permission("edits")).toEqual(["--permission-mode", "default"]);
    expect(permission("plan")).toEqual(["--permission-mode", "plan"]);
    expect(permission("auto")).toEqual(["--permission-mode", "default"]);
    expect(permission("bypass")).toEqual(["--dangerously-skip-permissions"]);
  });
  test("a guard is handed to the program as a hook that runs before every tool", () => {
    const a = buildArgv({ command: "agent", mode: "auto", guard: "'/bin/navvied' guard" });
    const settings = JSON.parse(a[a.indexOf("--settings") + 1]!) as { hooks: { PreToolUse: { matcher: string; hooks: { type: string; command: string; timeout?: number }[] }[] } };
    expect(settings.hooks.PreToolUse).toEqual([{ matcher: "*", hooks: [{ type: "command", command: "'/bin/navvied' guard", timeout: 3600 }] }]);
    expect(buildArgv({ command: "agent", mode: "auto" })).not.toContain("--settings");
  });
  test("plan mode uses the agent's read-only mode", () => {
    const a = buildArgv({ command: "agent", mode: "plan" });
    expect(a[a.indexOf("--permission-mode") + 1]).toBe("plan");
    expect(a).not.toContain("--dangerously-skip-permissions");
    expect(a).not.toContain("--model");
    expect(a).not.toContain("--resume");
  });
});
