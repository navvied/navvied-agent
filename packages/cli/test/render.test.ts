import { beforeAll, describe, expect, test } from "bun:test";
import { resolveTheme, setTheme } from "../src/theme.ts";
import type { EngineEvent } from "@navvied/protocol";
import { Renderer, describeTool } from "../src/render.ts";
import { fakeIO } from "./helpers.ts";

/** These tests look at colour codes, which depend on the shared theme: start from the default one. */
beforeAll(() => setTheme(resolveTheme(null, {})));

describe("describeTool", () => {
  test("a short description per tool", () => {
    expect(describeTool("Bash", { command: "ls -la\n  && echo   hi" })).toBe("$ ls -la && echo hi");
    expect(describeTool("Edit", { file_path: "/a/b.ts" })).toBe("/a/b.ts");
    expect(describeTool("Grep", { pattern: "needle" })).toBe("needle");
    expect(describeTool("WebFetch", { url: "https://example.com" })).toBe("https://example.com");
    expect(describeTool("Unknown", { x: 1 })).toBe("");
    expect(describeTool("Bash", null)).toBe("$ ");
    expect(describeTool("Bash", { command: "x".repeat(300) }).length).toBeLessThan(110);
  });
});

describe("Renderer", () => {
  test("the answer goes to stdout, the work to stderr", () => {
    const f = fakeIO();
    const r = new Renderer(f.io, { thinking: false });
    r.handle({ ev: "text", text: "Hello " });
    r.handle({ ev: "text", text: "world" });
    r.handle({ ev: "tool", id: "t1", name: "Bash", status: "running", progress: 0 }); // announced, no input yet: silent
    r.handle({ ev: "tool", id: "t1", name: "Bash", status: "running", input: { command: "echo hi" } });
    r.handle({ ev: "tool", id: "t1", name: "Bash", status: "done", output: "hi\n[exit 0]" });
    r.handle({ ev: "usage", ctx: 1000, win: 4000, out: 5 });
    r.handle({ ev: "done", stop: "end_turn" });
    expect(f.out()).toBe("Hello world\n");
    expect(f.err()).toContain("● Bash $ echo hi");
    expect(f.err()).toContain("✓ hi");
    expect(f.err()).toContain("Context 25% (1,000 of 4,000 tokens)");
  });

  test("tool errors, plans, approvals, plan proposals, errors and compaction notes", () => {
    const f = fakeIO();
    const r = new Renderer(f.io, { thinking: false });
    r.handle({ ev: "tool", id: "a", name: "Edit", status: "error", output: "Error: old_string was not found." });
    r.handle({ ev: "plan", entries: [{ title: "one", status: "completed" }, { title: "two", status: "in_progress" }, { title: "three", status: "pending" }] });
    r.handle({ ev: "approval", id: "p1", title: "Run command: ls", options: [] });
    r.handle({ ev: "plan_proposal", id: "pp" });
    r.handle({ ev: "phase", name: "compacting" });
    r.handle({ ev: "error", msg: "boom" });
    const err = f.err();
    expect(err).toContain("✗ Error: old_string was not found.");
    expect(err).toContain("[x] one");
    expect(err).toContain("[~] two");
    expect(err).toContain("[ ] three");
    expect(err).toContain("approval needed: Run command: ls");
    expect(err).toContain("Plan ready.");
    expect(err).toContain("compacting the conversation");
    expect(err).toContain("error: boom");
  });

  test("checkpoints are listed with a number, an id, their age and repositories", () => {
    const f = fakeIO();
    const now = Date.now();
    const r = new Renderer(f.io, { thinking: false });
    r.handle({ ev: "checkpoints", items: [{ id: "k1", at: now - 5_000, label: "first change", repos: ["app"] }, { id: "k2", at: now - 7_200_000, label: "second change", repos: ["app", "lib"] }] });
    expect(f.err()).toBe("  1  k1  just now  first change  (app)\n  2  k2  2 h ago  second change  (app, lib)\n");
    const g = fakeIO();
    new Renderer(g.io, { thinking: false }).handle({ ev: "checkpoints", items: [] });
    expect(g.err()).toBe("no checkpoints yet\n");
  });

  test("a restore preview and a finished restore describe each change; undo is offered", () => {
    const f = fakeIO();
    const r = new Renderer(f.io, { thinking: false });
    const changes = [{ repo: "app", path: "a.ts", change: "revert" as const }, { repo: "app", path: "b.ts", change: "recreate" as const }, { repo: "app", path: "c.ts", change: "remove" as const }];
    r.handle({ ev: "restore", id: "k1", preview: true, changes });
    expect(f.err()).toContain("revert  a.ts");
    expect(f.err()).toContain("bring back  b.ts");
    expect(f.err()).toContain("delete  c.ts");
    const g = fakeIO();
    new Renderer(g.io, { thinking: false }).handle({ ev: "restore", id: "k1", preview: false, changes, undoId: "u9" });
    expect(g.err()).toContain("reverted  a.ts");
    expect(g.err()).toContain("restored 3 files; undo with: restore u9");
    const h = fakeIO();
    new Renderer(h.io, { thinking: false }).handle({ ev: "restore", id: "k1", preview: true, changes: [] });
    expect(h.err()).toBe("nothing to restore: the code already matches\n");
  });

  test("reasoning text is hidden unless asked for", () => {
    const quiet = fakeIO(), loud = fakeIO();
    new Renderer(quiet.io, { thinking: false }).handle({ ev: "thought", text: "hmm" });
    new Renderer(loud.io, { thinking: true }).handle({ ev: "thought", text: "hmm" });
    expect(quiet.err()).toBe("");
    expect(loud.err()).toContain("hmm");
  });

  test("a step after unfinished text starts on a fresh line; stopped turns say so", () => {
    const f = fakeIO();
    const r = new Renderer(f.io, { thinking: false });
    r.handle({ ev: "text", text: "partial" });
    r.handle({ ev: "tool", id: "t", name: "Read", status: "running", input: { file_path: "a.ts" } });
    expect(f.out()).toBe("partial\n");
    r.handle({ ev: "done", stop: "cancelled" });
    expect(f.err()).toContain("Stopped");
  });

  test("colour only when enabled", () => {
    const plain = fakeIO(), colour = fakeIO({ color: true });
    new Renderer(plain.io, { thinking: false }).handle({ ev: "error", msg: "x" });
    new Renderer(colour.io, { thinking: false }).handle({ ev: "error", msg: "x" });
    expect(plain.err()).toBe("error: x\n");
    expect(colour.err()).toContain("\u001b[31m");
  });

  test("events with nothing to show print nothing", () => {
    const f = fakeIO();
    const r = new Renderer(f.io, { thinking: false });
    const quiet: EngineEvent[] = [{ ev: "session", id: "s" }, { ev: "caps", steer: true, modes: [], compact: true }, { ev: "taken", qid: "q" }, { ev: "alive" }];
    for (const e of quiet) r.handle(e);
    expect(f.out() + f.err()).toBe("");
  });
});
