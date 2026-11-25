import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { commandHooks } from "../src/index.ts";
import { cleanupAll, prompt, rig, until } from "./helpers.ts";
import { stopAllJobs } from "../src/index.ts";
import { HOOK_MS, hook, removeTree } from "../../protocol/test/support/cleanup.ts";

const dir = mkdtempSync(join(tmpdir(), "navvied-hooks-"));
afterAll(hook("hooks removes what it made", async () => { await stopAllJobs(); await removeTree(dir); await cleanupAll(); }), HOOK_MS);

// Forward slashes: on Windows the hook runs in Git Bash, which takes a word for a program's path only when it has a slash.
const slashed = (p: string): string => p.replaceAll(sep, "/");
const script = (name: string, body: string): string => { const p = join(dir, name); writeFileSync(p, body); return `"${slashed(process.execPath)}" "${slashed(p)}"`; };
const signal = new AbortController().signal;
const log = join(dir, "events.log");
const record = script("record.js", `const fs=require("fs");let d="";process.stdin.on("data",c=>d+=c).on("end",()=>fs.appendFileSync(${JSON.stringify(log)},d));`);
const deny = script("deny.js", `process.stdin.resume();process.stdin.on("end",()=>{console.error("no commands on Fridays");process.exit(2);});`);
const fail = script("fail.js", `process.stdin.resume();process.stdin.on("end",()=>{console.error("something broke");process.exit(1);});`);
const slow = script("slow.js", `setTimeout(()=>{},60000);process.stdin.resume();`);

describe("hooks that run commands", () => {
  test("a command gets the event as JSON on standard input", async () => {
    const hooks = commandHooks({ PostToolUse: [{ command: record }] }, dir, () => "sess1");
    await hooks.post({ tool: "Bash", input: { command: "ls" }, output: "a\nb" }, signal);
    const seen = JSON.parse(readFileSync(log, "utf8").trim().split("\n").at(-1)!);
    expect(seen).toEqual({ event: "PostToolUse", cwd: dir, session: "sess1", tool: "Bash", input: { command: "ls" }, output: "a\nb", hook_event_name: "PostToolUse", session_id: "sess1", tool_name: "Bash", tool_input: { command: "ls" }, tool_response: "a\nb" });
  });
  test("before a tool, exit code 2 stops it and the reason is what the command wrote on standard error", async () => {
    const hooks = commandHooks({ PreToolUse: [{ command: deny }] }, dir, () => "s");
    expect(await hooks.pre({ tool: "Bash", input: {} }, signal)).toMatchObject({ block: "no commands on Fridays", notes: [] });
  });
  test("a command that fails, or runs too long, is a note and never stops the tool", async () => {
    const hooks = commandHooks({ PreToolUse: [{ command: fail }, { command: slow, timeout: 0.3 }] }, dir, () => "s");
    const result = await hooks.pre({ tool: "Read", input: {} }, signal);
    expect(result.block).toBeUndefined();
    expect(result.notes[0]).toContain("failed (exit 1): something broke");
    expect(result.notes[1]).toContain("took longer than 0.3 s and was stopped");
  });
  test("the matcher picks tools by name, as a whole-name pattern; a broken pattern matches nothing", async () => {
    const hooks = commandHooks({ PreToolUse: [{ matcher: "Bash|Write", command: deny }, { matcher: "(", command: deny }] }, dir, () => "s");
    expect((await hooks.pre({ tool: "Read", input: {} }, signal)).block).toBeUndefined();
    expect((await hooks.pre({ tool: "Write", input: {} }, signal)).block).toBe("no commands on Fridays");
    expect((await hooks.pre({ tool: "Bash2", input: {} }, signal)).block).toBeUndefined();
  });
  test("a command that does not exist is a note, not a crash", async () => {
    const hooks = commandHooks({ PreToolUse: [{ command: "navvied-no-such-hook-program" }] }, dir, () => "s");
    const result = await hooks.pre({ tool: "Read", input: {} }, signal);
    expect(result.block).toBeUndefined();
    expect(result.notes[0]).toContain("failed");
  });
  test("stopping the turn stops a running hook", async () => {
    const hooks = commandHooks({ PreToolUse: [{ command: slow }] }, dir, () => "s");
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 100);
    const started = Date.now();
    await hooks.pre({ tool: "Read", input: {} }, stop.signal);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe("the engine with hooks", () => {
  const writes = (dirPath: string) => (req: { messages: { role: string }[] }) =>
    req.messages.at(-1)?.role === "tool" ? { text: "done" } : { calls: [{ name: "Write", args: { file_path: join(dirPath, "out.txt"), content: "x" } }] };

  test("a tool that a hook stops is not run, and the model is told why", async () => {
    const r = rig((req, _n, d) => writes(d)(req), { hooks: commandHooks({ PreToolUse: [{ matcher: "Write", command: deny }] }, dir, () => "s") });
    await r.turn(prompt("write it"));
    expect(existsSync(join(r.dir, "out.txt"))).toBe(false);
    const result = r.of("tool").find((e) => e.name === "Write" && e.status === "error")!;
    expect(result.output).toBe("Blocked by a hook: no commands on Fridays");
    expect(String(r.provider.requests[1]!.messages.at(-1)!.content)).toContain("Blocked by a hook");
    r.cleanup();
  });
  test("after a tool the hook sees what happened, and a turn end is reported to the stop hook", async () => {
    writeFileSync(log, "");
    const r = rig((req, _n, d) => writes(d)(req), { hooks: commandHooks({ PostToolUse: [{ command: record }], Stop: [{ command: record }] }, dir, () => "s") });
    await r.turn(prompt("write it"));
    await until(() => readFileSync(log, "utf8").split("\n").filter(Boolean).length >= 2);
    const seen = readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    expect(seen.map((s) => s.event).sort()).toEqual(["PostToolUse", "Stop"]);
    expect(seen.find((s) => s.event === "PostToolUse").tool).toBe("Write");
    expect(seen.find((s) => s.event === "Stop").reason).toBe("end_turn");
    expect(existsSync(join(r.dir, "out.txt"))).toBe(true);
    r.cleanup();
  });
  test("a hook that fails is a notice and the tool still runs", async () => {
    const r = rig((req, _n, d) => writes(d)(req), { hooks: commandHooks({ PreToolUse: [{ command: fail }] }, dir, () => "s") });
    await r.turn(prompt("write it"));
    expect(existsSync(join(r.dir, "out.txt"))).toBe(true);
    expect(r.of("notice")[0]!.msg).toContain("failed (exit 1)");
    expect(r.of("error")).toEqual([]);
    r.cleanup();
  });
});

describe("hooks around a message and a session", () => {
  const say = (text: string) => script(`say-${text.length}.js`, `process.stdin.resume();process.stdin.on("end",()=>console.log(${JSON.stringify(text)}));`);

  test("UserPromptSubmit: exit code 2 stops the message with the reason, and what a command prints is added as context", async () => {
    const hooks = commandHooks({ UserPromptSubmit: [{ command: deny }] }, dir, () => "s");
    expect(await hooks.prompt!({ text: "hi", first: false }, signal)).toMatchObject({ block: "no commands on Fridays", notes: [] });
    const adds = commandHooks({ UserPromptSubmit: [{ command: say("today is a holiday") }] }, dir, () => "s");
    expect(await adds.prompt!({ text: "hi", first: false }, signal)).toEqual({ context: "today is a holiday", notes: [] });
  });
  test("SessionStart runs only for the first message of a session", async () => {
    const hooks = commandHooks({ SessionStart: [{ command: say("project rules: tabs") }] }, dir, () => "s");
    expect((await hooks.prompt!({ text: "hi", first: true }, signal)).context).toBe("project rules: tabs");
    expect((await hooks.prompt!({ text: "hi", first: false }, signal)).context).toBeUndefined();
  });
  test("PreCompact tells the command whether it was asked for", async () => {
    const hooks = commandHooks({ PreCompact: [{ command: record }] }, dir, () => "s");
    await hooks.compact!({ manual: true }, signal);
    expect(JSON.parse(readFileSync(log, "utf8").trim().split("\n").at(-1)!)).toMatchObject({ event: "PreCompact", manual: true });
  });
  test("in the engine: a blocked message is never taken, and a hook's text reaches the model with the message", async () => {
    const blocked = rig(() => ({ text: "should not run" }), { hooks: commandHooks({ UserPromptSubmit: [{ command: deny }] }, dir, () => "s") });
    const t = await blocked.turn(prompt("do it"));
    expect(t.some((e) => e.ev === "error" && /no commands on Fridays/.test(e.msg))).toBe(true);
    expect(blocked.provider.requests).toHaveLength(0);
    blocked.cleanup();
    const added = rig(() => ({ text: "ok" }), { hooks: commandHooks({ UserPromptSubmit: [{ command: say("remember: metric units") }] }, dir, () => "s") });
    await added.turn(prompt("how far is a mile?"));
    expect(JSON.stringify(added.provider.requests[0]!.messages)).toContain("remember: metric units");
    added.cleanup();
  });
});
