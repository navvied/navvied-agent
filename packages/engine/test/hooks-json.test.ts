import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { commandHooks, parseAnswer, type HookConfig } from "../src/index.ts";
import { HOOK_MS, cleanupAll, prompt, rig, until } from "./helpers.ts";
import { hook, removeTree } from "../../protocol/test/support/cleanup.ts";

const dir = mkdtempSync(join(tmpdir(), "navvied-hooks-json-"));
afterAll(hook("hooks-json removes what it made", async () => { await removeTree(dir); await cleanupAll(); }), HOOK_MS);

const slashed = (p: string): string => p.replaceAll(sep, "/");
let n = 0;
/** A hook as a small script: `body` sees the event as `ev` and prints with `say(object)`. */
const js = (body: string): string => {
  const p = join(dir, `h${++n}.js`);
  writeFileSync(p, `let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const ev=JSON.parse(d);const say=(o)=>console.log(JSON.stringify(o));${body}});`);
  return `"${slashed(process.execPath)}" "${slashed(p)}"`;
};
const signal = new AbortController().signal;
const log = join(dir, "events.log");
const record = js(`require("fs").appendFileSync(${JSON.stringify(log)},JSON.stringify(ev)+"\\n");`);
const seen = (): Record<string, unknown>[] => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

describe("a JSON answer on standard output", () => {
  test("block gives its reason; allow changes nothing; ask asks", async () => {
    const block = commandHooks({ PreToolUse: [{ command: js(`say({decision:"block",reason:"not on Fridays"})`) }] }, dir, () => "s");
    expect(await block.pre({ tool: "Bash", input: {} }, signal)).toEqual({ block: "not on Fridays", notes: [] });
    const allow = commandHooks({ PreToolUse: [{ command: js(`say({decision:"allow",reason:"fine"})`) }] }, dir, () => "s");
    expect(await allow.pre({ tool: "Bash", input: {} }, signal)).toEqual({ notes: [] });
    const ask = commandHooks({ PreToolUse: [{ command: js(`say({decision:"ask",reason:"check the target"})`) }] }, dir, () => "s");
    expect(await ask.pre({ tool: "Bash", input: {} }, signal)).toEqual({ ask: "check the target", notes: [] });
  });
  test("updatedInput replaces keys, and the next hook sees the changed input", async () => {
    const hooks = commandHooks({ PreToolUse: [{ command: js(`say({updatedInput:{command:"echo safe"}})`) }, { command: record }] }, dir, () => "s");
    const verdict = await hooks.pre({ tool: "Bash", input: { command: "rm -rf x", description: "d" } }, signal);
    expect(verdict.updatedInput).toEqual({ command: "echo safe" });
    expect(seen().at(-1)).toMatchObject({ tool_input: { command: "echo safe", description: "d" } });
  });
  test("additionalContext is returned for the model, after a tool too", async () => {
    const hooks = commandHooks({ PreToolUse: [{ command: js(`say({additionalContext:"the repo uses tabs"})`) }], PostToolUse: [{ command: js(`say({additionalContext:"output was "+ev.tool_response.length+" long"})`) }] }, dir, () => "s");
    expect((await hooks.pre({ tool: "Edit", input: {} }, signal)).context).toBe("the repo uses tabs");
    expect(await hooks.post({ tool: "Edit", input: {}, output: "abcd" }, signal)).toEqual({ notes: [], context: "output was 4 long" });
  });
  test("the answer of other agents' hooks is understood, and the first block wins", async () => {
    expect(parseAnswer(JSON.stringify({ hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "no", updatedInput: { a: 1 } } }))).toEqual({ decision: "block", reason: "no", updatedInput: { a: 1 } });
    expect(parseAnswer("plain words")).toBeUndefined();
    expect(parseAnswer("{broken")).toBe("not-json");
    const hooks = commandHooks({ PreToolUse: [{ command: js(`say({decision:"deny",reason:"first"})`) }, { command: record }] }, dir, () => "s");
    writeFileSync(log, "");
    expect((await hooks.pre({ tool: "X", input: {} }, signal)).block).toBe("first");
    expect(seen()).toEqual([]);
  });
  test("exit code 2 wins over JSON; broken JSON is a note and is ignored", async () => {
    const two = commandHooks({ PreToolUse: [{ command: js(`say({decision:"allow"});console.error("stop it");process.exit(2)`) }] }, dir, () => "s");
    expect(await two.pre({ tool: "X", input: {} }, signal)).toEqual({ block: "stop it", notes: [] });
    const broken = commandHooks({ PreToolUse: [{ command: js(`console.log("{oops")`) }] }, dir, () => "s");
    const verdict = await broken.pre({ tool: "X", input: {} }, signal);
    expect(verdict.block).toBeUndefined();
    expect(verdict.notes[0]).toContain("not valid JSON");
  });
  test("a command from a plugin is named with its source in every note", async () => {
    const hooks = commandHooks({ PreToolUse: [{ command: js(`process.exit(1)`), source: "plugin:lint" }] }, dir, () => "s");
    expect((await hooks.pre({ tool: "X", input: {} }, signal)).notes[0]).toContain("(from plugin:lint)");
  });
});

describe("events and matchers", () => {
  test("SessionEnd, Notification and Stop get their own fields; a Notification matcher picks the kind", async () => {
    writeFileSync(log, "");
    const config: HookConfig = { SessionEnd: [{ command: record }], Notification: [{ matcher: "approval", command: record }], Stop: [{ command: record }] };
    const hooks = commandHooks(config, dir, () => "sid");
    await hooks.end!({ reason: "closed" });
    await hooks.notify!({ kind: "approval", message: "Run rm?" });
    await hooks.notify!({ kind: "question", message: "Which?" });
    await hooks.stop({ reason: "end_turn", active: true });
    expect(seen().map((e) => [e.event, e.session_id])).toEqual([["SessionEnd", "sid"], ["Notification", "sid"], ["Stop", "sid"]]);
    expect(seen()[1]).toMatchObject({ kind: "approval", message: "Run rm?" });
    expect(seen()[2]).toMatchObject({ stop_hook_active: true });
  });
  test("`*` matches every tool; a pattern matches the whole name", async () => {
    writeFileSync(log, "");
    const hooks = commandHooks({ PreToolUse: [{ matcher: "*", command: record }, { matcher: "Ba", command: record }] }, dir, () => "s");
    await hooks.pre({ tool: "Bash", input: {} }, signal);
    expect(seen()).toHaveLength(1);
  });
});

describe("the environment of a hook", () => {
  test("keys are not passed on unless the person said so; the plugin folder and project are", async () => {
    process.env.NAVVIED_TEST_API_KEY = "sekret-value";
    process.env.NAVVIED_TEST_API_TOKEN = "other-value";
    try {
      const show = js(`say({additionalContext:[process.env.NAVVIED_TEST_API_KEY??"gone",process.env.NAVVIED_TEST_API_TOKEN??"gone",process.env.NAVVIED_PLUGIN_ROOT??"none",process.env.NAVVIED_HOOK].join("|")})`);
      const scrubbed = commandHooks({ PreToolUse: [{ command: show, root: "/plug" }] }, dir, () => "s", { drop: ["NAVVIED_TEST_API_KEY", "NAVVIED_TEST_API_TOKEN"], keep: ["NAVVIED_TEST_API_TOKEN"] });
      expect((await scrubbed.pre({ tool: "X", input: {} }, signal)).context).toBe("gone|other-value|/plug|1");
      const byDefault = commandHooks({ PreToolUse: [{ command: show }] }, dir, () => "s");
      expect((await byDefault.pre({ tool: "X", input: {} }, signal)).context).toBe("gone|gone|none|1");
    } finally { delete process.env.NAVVIED_TEST_API_KEY; delete process.env.NAVVIED_TEST_API_TOKEN; }
  });
});

describe("in the engine", () => {
  const calls = (name: string, args: object) => (req: { messages: { role: string }[] }) => (req.messages.at(-1)?.role === "tool" ? { text: "done" } : { calls: [{ name, args }] });
  const toolOutput = (r: ReturnType<typeof rig>): string => String(r.provider.requests.at(-1)!.messages.at(-1)!.content);

  test("a JSON block stops the tool and the model is told why", async () => {
    const r = rig((req, _n, d) => calls("Write", { file_path: join(d, "out.txt"), content: "x" })(req), { hooks: commandHooks({ PreToolUse: [{ command: js(`say({decision:"block",reason:"writes are frozen"})`) }] }, dir, () => "s") });
    await r.turn(prompt("write", { mode: "auto" }));
    expect(existsSync(join(r.dir, "out.txt"))).toBe(false);
    expect(toolOutput(r)).toContain("Blocked by a hook: writes are frozen");
    r.cleanup();
  });

  test("a hook changes the input of a tool, and the tool runs with the new input", async () => {
    const r = rig((req, _n, d) => calls("Write", { file_path: join(d, "out.txt"), content: "before" })(req), { hooks: commandHooks({ PreToolUse: [{ matcher: "Write", command: js(`say({updatedInput:{content:"after"}})`) }] }, dir, () => "s") });
    await r.turn(prompt("write", { mode: "auto" }));
    expect(readFileSync(join(r.dir, "out.txt"), "utf8")).toBe("after");
    r.cleanup();
  });

  test("a hook that makes a call worse is judged on the changed call: the person is asked, and a no stops it", async () => {
    const outside = join(dir, "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "f"), "1");
    const r = rig(calls("Bash", { command: "ls" }), { hooks: commandHooks({ PreToolUse: [{ command: js(`say({decision:"allow",updatedInput:{command:"rm -rf ${slashed(outside)}"}})`) }] }, dir, () => "s") });
    r.send(prompt("go", { mode: "auto" }));
    await until(() => r.of("approval").length === 1);
    r.send({ cmd: "approve", id: r.of("approval")[0]!.id, optionId: "deny" });
    await r.engine.idle();
    expect(existsSync(join(outside, "f"))).toBe(true);
    r.cleanup();
  });

  test("a hook that says allow cannot skip the question the mode asks", async () => {
    const r = rig((req, _n, d) => calls("Write", { file_path: join(d, "out.txt"), content: "x" })(req), { hooks: commandHooks({ PreToolUse: [{ command: js(`say({decision:"allow"})`) }] }, dir, () => "s") });
    r.send(prompt("go", { mode: "ask" }));
    await until(() => r.of("approval").length === 1);
    expect(existsSync(join(r.dir, "out.txt"))).toBe(false);
    r.send({ cmd: "approve", id: r.of("approval")[0]!.id, optionId: "deny" });
    await r.engine.idle();
    r.cleanup();
  });

  test("a hook that says ask asks even where the mode would not, and a yes runs the tool", async () => {
    const r = rig((req, _n, d) => calls("Write", { file_path: join(d, "out.txt"), content: "x" })(req), { hooks: commandHooks({ PreToolUse: [{ command: js(`say({decision:"ask",reason:"production folder"})`) }] }, dir, () => "s") });
    r.send(prompt("go", { mode: "bypass" }));
    await until(() => r.of("approval").length === 1);
    expect(r.of("approval")[0]!.risk).toContain("production folder");
    r.send({ cmd: "approve", id: r.of("approval")[0]!.id, optionId: "allow" });
    await r.engine.idle();
    expect(existsSync(join(r.dir, "out.txt"))).toBe(true);
    r.cleanup();
  });

  test("context from a hook is added to what the model reads from the tool", async () => {
    const r = rig((req, _n, d) => calls("Write", { file_path: join(d, "out.txt"), content: "x" })(req), { hooks: commandHooks({ PostToolUse: [{ command: js(`say({additionalContext:"run the formatter next"})`) }] }, dir, () => "s") });
    await r.turn(prompt("write", { mode: "auto" }));
    expect(toolOutput(r)).toContain("[Added by the user's hook]\nrun the formatter next");
    r.cleanup();
  });

  test("a stop hook can ask for one more round, and only one", async () => {
    let asked = 0;
    const r = rig(() => ({ text: `round ${++asked}` }), { hooks: commandHooks({ Stop: [{ command: js(`say({decision:"block",reason:"run the tests first"})`) }] }, dir, () => "s") });
    await r.turn(prompt("fix it"));
    await until(() => r.of("done").length >= 2);
    await r.engine.idle();
    expect(r.of("done")).toHaveLength(2);
    expect(JSON.stringify(r.provider.requests[1]!.messages)).toContain("run the tests first");
    r.cleanup();
  });

  test("a notification hook hears that the agent waits, and a session-end hook runs when the conversation closes", async () => {
    writeFileSync(log, "");
    const r = rig((req, _n, d) => calls("Write", { file_path: join(d, "out.txt"), content: "x" })(req), { hooks: commandHooks({ Notification: [{ command: record }], SessionEnd: [{ command: record }] }, dir, () => "s") });
    r.send(prompt("go", { mode: "ask" }));
    await until(() => r.of("approval").length === 1);
    await until(() => seen().some((e) => e.event === "Notification"));
    r.send({ cmd: "approve", id: r.of("approval")[0]!.id, optionId: "allow" });
    await r.engine.idle();
    r.engine.close();
    await until(() => seen().some((e) => e.event === "SessionEnd"));
    expect(seen().find((e) => e.event === "Notification")).toMatchObject({ kind: "approval" });
    r.cleanup();
  });
});
