import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { commandHooks, stopAllJobs, type Hooks } from "../src/index.ts";
import { cleanupAll, prompt, rig } from "./helpers.ts";
import { HOOK_MS, hook, removeTree } from "../../protocol/test/support/cleanup.ts";

const dir = mkdtempSync(join(tmpdir(), "navvied-hooks-said-"));
afterAll(hook("hooks-said removes what it made", async () => { await stopAllJobs(); await removeTree(dir); await cleanupAll(); }), HOOK_MS);

const slashed = (p: string): string => p.replaceAll(sep, "/");
const script = (name: string, body: string): string => { const p = join(dir, name); writeFileSync(p, body); return `"${slashed(process.execPath)}" "${slashed(p)}"`; };
const answer = (name: string, json: unknown): string => script(name, `process.stdin.resume();process.stdin.on("end",()=>console.log(${JSON.stringify(JSON.stringify(json))}));`);
const deny = script("deny.js", `process.stdin.resume();process.stdin.on("end",()=>{console.error("no commands on Fridays");process.exit(2);});`);
const signal = new AbortController().signal;

describe("what each hook decided is data: which hook, what it did, and why", () => {
  test("a block by exit code, with where the hook comes from", async () => {
    const hooks = commandHooks({ PreToolUse: [{ command: deny, source: "plugin:calendar" }] }, dir, () => "s");
    const r = await hooks.pre({ tool: "Bash", input: {} }, signal);
    expect(r.said).toEqual([{ event: "PreToolUse", decision: "blocked", hook: deny, source: "plugin:calendar", reason: "no commands on Fridays" }]);
  });
  test("allow, ask and change are each said by the hook that gave them, in order", async () => {
    const allow = answer("allow.js", { decision: "allow", reason: "known command" });
    const ask = answer("ask.js", { decision: "ask", reason: "look at this first" });
    const change = answer("change.js", { updatedInput: { command: "ls" }, reason: "safer" });
    const r = await commandHooks({ PreToolUse: [{ command: allow }, { command: ask }, { command: change }] }, dir, () => "s").pre({ tool: "Bash", input: { command: "rm -r x" } }, signal);
    expect(r.said?.map((s) => [s.decision, s.reason])).toEqual([["allowed", "known command"], ["asked", "look at this first"], ["changed", "safer"]]);
    expect(r.ask).toBe("look at this first");
    expect(r.updatedInput).toEqual({ command: "ls" });
  });
  test("what a hook adds for the model after a step is `added`, and a hook that says nothing says nothing", async () => {
    const more = answer("more.js", { additionalContext: "remember the tests" });
    const quiet = script("quiet.js", `process.stdin.resume();process.stdin.on("end",()=>{});`);
    const r = await commandHooks({ PostToolUse: [{ command: more }, { command: quiet }] }, dir, () => "s").post({ tool: "Edit", input: {}, output: "ok" }, signal);
    expect(r.said).toEqual([{ event: "PostToolUse", decision: "added", hook: more, reason: "remember the tests" }]);
  });
  test("a hook of the message and of the end of the turn says so too", async () => {
    const hooks = commandHooks({ UserPromptSubmit: [{ command: deny }], Stop: [{ command: deny }] }, dir, () => "s");
    expect((await hooks.prompt!({ text: "hi", first: false }, signal)).said?.[0]).toMatchObject({ event: "UserPromptSubmit", decision: "blocked" });
    expect((await hooks.stop({ reason: "end_turn" })).said?.[0]).toMatchObject({ event: "Stop", decision: "blocked" });
  });
});

describe("the engine tells the person", () => {
  const said = [{ event: "PreToolUse" as const, decision: "blocked" as const, hook: "check.sh", source: "plugin:style", reason: "no" }];
  const fake = (pre: Hooks["pre"], post?: Hooks["post"]): Hooks => ({ pre, post: post ?? (async () => ({ notes: [] })), stop: async () => ({ notes: [] }) });

  test("a hook that blocked a step is an event about that step, before the step's answer", async () => {
    const r = rig((_req, n) => (n === 0 ? { calls: [{ name: "Read", args: { file_path: "x.txt" }, id: "t1" }] } : { text: "done" }), { hooks: fake(async () => ({ notes: [], block: "no", said })) });
    await r.turn(prompt("go"));
    const heard = r.of("hook");
    expect(heard).toEqual([{ ev: "hook", event: "PreToolUse", decision: "blocked", hook: "check.sh", source: "plugin:style", step: "t1", tool: "Read", reason: "no" }]);
    const order = r.events.map((e) => e.ev === "hook" ? "hook" : e.ev === "tool" ? `tool:${e.status}` : e.ev);
    expect(order.indexOf("hook")).toBeLessThan(order.lastIndexOf("tool:error"));
  });

  test("a secret the person typed is not in what a hook said", async () => {
    const said2 = [{ event: "PostToolUse" as const, decision: "added" as const, hook: "log.sh --token hunter2hunter2", reason: "saw hunter2hunter2" }];
    const r = rig((_req, n) => (n === 0 ? { calls: [{ name: "Read", args: { file_path: "x.txt" }, id: "t1" }] } : { text: "done" }), { hooks: fake(async () => ({ notes: [] }), async () => ({ notes: [], said: said2 })), secrets: ["hunter2hunter2"] });
    await r.turn(prompt("go"));
    expect(JSON.stringify(r.of("hook"))).not.toContain("hunter2hunter2");
    expect(r.of("hook")).toHaveLength(1);
  });
});
