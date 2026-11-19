import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineEvent } from "@navvied/protocol";
import { CodexEngine, codexArgv } from "../src/codex-engine.ts";
import { hook, removeTrees } from "../../protocol/test/support/cleanup.ts";

const dirs: string[] = [];
const temp = (): string => { const d = mkdtempSync(join(tmpdir(), "navvied-codex-")); dirs.push(d); return d; };
afterAll(hook("codex-engine removes what it made", async () => { await removeTrees(dirs); }));

const SCRIPT = `
const fs = require("fs");
const log = process.env.ARGV_LOG;
if (log) fs.appendFileSync(log, JSON.stringify(process.argv.slice(2)) + "\\n");
const prompt = fs.readFileSync(0, "utf8").trim();
const out = (o) => console.log(JSON.stringify(o));
const thread = process.argv.includes("resume") ? process.argv[process.argv.indexOf("resume") + 1] : "T-" + Math.random().toString(36).slice(2, 8);
out({ type: "thread.started", thread_id: thread });
out({ type: "turn.started" });
if (prompt.startsWith("fail")) { out({ type: "error", message: "Reconnecting... 1/5" }); out({ type: "turn.failed", error: { message: "unexpected status 401 Unauthorized" } }); }
else if (prompt.startsWith("crash")) { console.error("2026-11-15T10:00:00Z ERROR noise"); console.error("the program could not start its sandbox"); process.exit(2); }
else if (prompt.startsWith("slow")) { setTimeout(() => out({ type: "turn.completed", usage: {} }), 30000); }
else if (prompt.startsWith("tools")) {
  out({ type: "item.started", item: { id: "c1", type: "command_execution", command: "ls" } });
  out({ type: "item.completed", item: { id: "c1", type: "command_execution", command: "ls", aggregated_output: "a\\n", exit_code: 0 } });
  out({ type: "item.completed", item: { id: "f1", type: "file_change", status: "completed", changes: [{ path: "a.ts", kind: "update" }] } });
  out({ type: "item.completed", item: { id: "m", type: "agent_message", text: "done" } });
  out({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } });
} else { out({ type: "item.completed", item: { id: "m", type: "agent_message", text: "echo:" + prompt } }); out({ type: "turn.completed", usage: { input_tokens: 100, output_tokens: 5 } }); }
`;

function rig(extra: { sessionId?: string; persona?: string } = {}) {
  const dir = temp();
  const script = join(dir, "fake-codex.js");
  writeFileSync(script, SCRIPT);
  const argvLog = join(dir, "argv.log");
  const events: EngineEvent[] = [];
  const engine = new CodexEngine({ command: process.execPath, args: [script], cwd: dir, window: 200_000, emit: (e) => events.push(e), env: { ARGV_LOG: argvLog }, ...extra });
  const calls = (): string[][] => { try { return readFileSync(argvLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]); } catch { return []; } };
  const names = (from = 0): string[] => events.slice(from).map((e) => e.ev);
  return { engine, events, calls, names, dir };
}

const prompt = (text: string, extra: object = {}) => ({ cmd: "prompt" as const, text, ...extra });

describe("switching model and effort", () => {
  const MODELS = [{ id: "default", name: "Let it choose" }, { id: "gpt-x", name: "Big" }];
  test("the model and the effort go on the command line of the next message, and the thread carries on", async () => {
    const r = rig();
    const engine = new CodexEngine({ command: process.execPath, args: [join(r.dir, "fake-codex.js")], cwd: r.dir, window: 200_000, emit: (e) => r.events.push(e), env: { ARGV_LOG: join(r.dir, "argv.log") }, models: MODELS, efforts: ["low", "high"] });
    expect(r.events.at(-1)).toMatchObject({ ev: "caps", models: [{ id: "default", current: true }, { id: "gpt-x", current: false }], efforts: ["low", "high"] });
    engine.handle(prompt("one"));
    await engine.idle();
    engine.handle({ cmd: "model", id: "gpt-x" });
    engine.handle({ cmd: "effort", level: "high" });
    expect(r.events.at(-1)).toMatchObject({ ev: "caps", effort: "high" });
    engine.handle(prompt("two"));
    await engine.idle();
    const [first, second] = r.calls();
    expect(first).not.toContain("-m");
    expect(second!.slice(0, 2)).toEqual(["exec", "resume"]);
    expect(second).toEqual(expect.arrayContaining(["-m", "gpt-x", "-c", 'model_reasoning_effort="high"']));
    engine.handle({ cmd: "model", id: "nope" });
    expect(r.events.at(-1)).toEqual({ ev: "error", msg: 'There is no model "nope".' });
    engine.handle({ cmd: "effort", level: "max" });
    expect(r.events.at(-1)).toEqual({ ev: "error", msg: "This model does not have the effort level max." });
    engine.close();
  });
  test("the command line puts the effort in the program's own setting", () => {
    expect(codexArgv({ command: "codex", mode: "auto", effort: "xhigh" })).toEqual(["codex", "exec", "--json", "--skip-git-repo-check", "-c", 'sandbox_mode="workspace-write"', "-c", 'model_reasoning_effort="xhigh"', "-"]);
  });
});

describe("the Codex command line", () => {
  test("one message is one run: JSON out, the sandbox by mode, the model if one is chosen, the prompt on standard input", () => {
    expect(codexArgv({ command: "codex", mode: "auto" })).toEqual(["codex", "exec", "--json", "--skip-git-repo-check", "-c", 'sandbox_mode="workspace-write"', "-"]);
    expect(codexArgv({ command: "codex", mode: "plan", model: "gpt-x", args: ["--profile", "p"] })).toEqual(["codex", "--profile", "p", "exec", "--json", "--skip-git-repo-check", "-c", 'sandbox_mode="read-only"', "-m", "gpt-x", "-"]);
  });

  test("a later message resumes the thread", () => {
    expect(codexArgv({ command: "codex", mode: "auto", thread: "T-9" }).slice(0, 4)).toEqual(["codex", "exec", "resume", "T-9"]);
  });
});

describe("working through the Codex program", () => {
  test("it says what it can do, then a turn gives the echo, the thread, the answer, the usage and the end, in order", async () => {
    const r = rig();
    expect(r.events[0]).toEqual({ ev: "caps", steer: false, modes: ["auto", "plan"], defaultMode: "auto", compact: false });
    r.engine.handle(prompt("hello", { qid: "q1" }));
    await r.engine.idle();
    // The program is starting until it says something: the person is told so, and then it is thinking.
    expect(r.names(1)).toEqual(["user", "taken", "phase", "phase", "session", "text", "usage", "done"]);
    expect(r.events.filter((e) => e.ev === "phase")).toEqual([{ ev: "phase", name: "starting" }, { ev: "phase", name: "" }]);
    expect(r.events.find((e) => e.ev === "user")).toEqual({ ev: "user", qid: "q1", text: "hello" });
    expect(r.events.find((e) => e.ev === "text")).toEqual({ ev: "text", text: "echo:hello\n" });
    expect(r.events.at(-1)).toEqual({ ev: "done", stop: "end_turn" });
    expect(r.engine.sessionId).toMatch(/^T-/);
    r.engine.close();
  });

  test("the next message resumes the same thread, and a quote, a newline or a long prompt arrives intact", async () => {
    const r = rig();
    r.engine.handle(prompt("one"));
    await r.engine.idle();
    const thread = r.engine.sessionId;
    const tricky = `say "hi" and 'bye'\nsecond line ${"x".repeat(5000)}`;
    r.engine.handle(prompt(tricky));
    await r.engine.idle();
    expect(r.calls()[1]!.slice(0, 3)).toEqual(["exec", "resume", thread]);
    expect((r.events.filter((e) => e.ev === "text").at(-1) as { text: string }).text).toBe(`echo:${tricky}\n`);
    r.engine.close();
  });

  test("who the agent is, is said once at the start of a thread and never again", async () => {
    const r = rig({ persona: "You are navvied." });
    r.engine.handle(prompt("hello", { qid: "q1" }));
    await r.engine.idle();
    r.engine.handle(prompt("again", { qid: "q2" }));
    await r.engine.idle();
    const said = r.events.filter((e) => e.ev === "text").map((e) => (e as { text: string }).text);
    expect(said).toEqual(["echo:You are navvied.\n\n---\n\nhello\n", "echo:again\n"]);
    expect(r.events.find((e) => e.ev === "user")).toEqual({ ev: "user", qid: "q1", text: "hello" });
    r.engine.close();
  });

  test("plan mode runs read-only, auto mode can write, and ask mode is refused", async () => {
    const r = rig();
    r.engine.handle(prompt("a", { mode: "plan" }));
    await r.engine.idle();
    r.engine.handle(prompt("b", { mode: "auto" }));
    await r.engine.idle();
    expect(r.calls()[0]).toContain('sandbox_mode="read-only"');
    expect(r.calls()[1]).toContain('sandbox_mode="workspace-write"');
    const before = r.events.length;
    r.engine.handle(prompt("c", { mode: "ask" }));
    expect(r.events.slice(before)).toEqual([{ ev: "error", msg: "This computer's engine is a program you are signed in to, and it can only run in Auto or Plan: it cannot ask before each change." }, { ev: "done", stop: "error" }]);
    expect(r.calls()).toHaveLength(2);
    r.engine.close();
  });

  test("tools, file changes and the answer come through as rows", async () => {
    const r = rig();
    r.engine.handle(prompt("tools please"));
    await r.engine.idle();
    const tools = r.events.filter((e) => e.ev === "tool");
    expect(tools.map((t) => `${(t as { name: string }).name}:${(t as { status: string }).status}`)).toEqual(["Bash:running", "Bash:done", "Edit:done"]);
    r.engine.close();
  });

  test("a turn that fails because of the sign-in says so, and the engine is ready for the next message", async () => {
    const r = rig();
    r.engine.handle(prompt("fail now"));
    await r.engine.idle();
    expect(r.events.filter((e) => e.ev === "error")).toEqual([{ ev: "error", msg: "Codex is not signed in. Use /model to sign in again." }]);
    expect(r.events.at(-1)).toEqual({ ev: "done", stop: "error" });
    r.engine.handle(prompt("hello"));
    await r.engine.idle();
    expect(r.events.at(-1)).toEqual({ ev: "done", stop: "end_turn" });
    r.engine.close();
  });

  test("a program that dies without a result is reported with its own last words, not its log noise", async () => {
    const r = rig();
    r.engine.handle(prompt("crash"));
    await r.engine.idle();
    expect(r.events.filter((e) => e.ev === "error")).toEqual([{ ev: "error", msg: "the program could not start its sandbox" }]);
    expect(r.events.at(-1)).toEqual({ ev: "done", stop: "error" });
    r.engine.close();
  });

  test("a program that cannot be started is an error, not a hang", async () => {
    const events: EngineEvent[] = [];
    const engine = new CodexEngine({ command: "/definitely/not/a/program", cwd: tmpdir(), window: 1000, emit: (e) => events.push(e) });
    engine.handle(prompt("hello"));
    await engine.idle();
    expect(events.some((e) => e.ev === "error" && /Could not start/.test(e.msg))).toBe(true);
    expect(events.at(-1)).toEqual({ ev: "done", stop: "error" });
  });

  test("cancelling stops the run at once, ends the turn as cancelled, and forgets what was waiting", async () => {
    const r = rig();
    r.engine.handle(prompt("slow one"));
    r.engine.handle(prompt("hello"));
    await new Promise((res) => setTimeout(res, 400));
    const started = Date.now();
    r.engine.handle({ cmd: "cancel" });
    await r.engine.idle();
    expect(Date.now() - started).toBeLessThan(3000);
    expect(r.events.at(-1)).toEqual({ ev: "done", stop: "cancelled" });
    expect(r.calls()).toHaveLength(1);
    r.engine.close();
  });

  test("a message sent while one is running waits its turn, and a repeated id is ignored", async () => {
    const r = rig();
    r.engine.handle(prompt("first", { qid: "a" }));
    r.engine.handle(prompt("second", { qid: "b" }));
    r.engine.handle(prompt("second again", { qid: "b" }));
    await r.engine.idle();
    await new Promise((res) => setTimeout(res, 50));
    await r.engine.idle();
    const texts = r.events.filter((e) => e.ev === "text").map((e) => (e as { text: string }).text);
    expect(texts).toEqual(["echo:first\n", "echo:second\n"]);
    expect(r.events.filter((e) => e.ev === "done")).toHaveLength(2);
    r.engine.close();
  });

  test("a thread given at the start is continued from the first message", async () => {
    const r = rig({ sessionId: "T-old" });
    expect(r.events[0]).toEqual({ ev: "session", id: "T-old" });
    r.engine.handle(prompt("hello"));
    await r.engine.idle();
    expect(r.calls()[0]!.slice(0, 3)).toEqual(["exec", "resume", "T-old"]);
    r.engine.close();
  });

  test("compact and load are explained, and closing during a run stops it", async () => {
    const r = rig();
    r.engine.handle({ cmd: "compact" });
    r.engine.handle({ cmd: "load", id: "x" });
    expect(r.events.filter((e) => e.ev === "error")).toHaveLength(2);
    r.engine.handle(prompt("slow"));
    await new Promise((res) => setTimeout(res, 300));
    r.engine.close();
    await r.engine.idle();
  });
});
