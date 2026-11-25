import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Rules, connectMcp, defaultTools, executeCode } from "../src/index.ts";
import type { Tool } from "../src/types.ts";
import { executeCodeTool } from "../src/tools/execute-code.ts";
import { HOOK_MS, cleanupAll, prompt, rig, until, type Rig } from "./helpers.ts";

afterAll(cleanupAll, HOOK_MS);

const script = (code: string) => ({ calls: [{ name: "ExecuteCode", args: { code } }] });
const HEAD = "from navvied_tools import *\n";
/** The tools of an engine that has the code tool switched on, with this one in place of the product's own. */
const base = (...extra: Tool[]): { tools: Tool[]; toolOn: () => boolean } => ({ tools: [...defaultTools().filter((t) => t.name !== "ExecuteCode"), ...extra], toolOn: () => true });

/** One turn in which the model sends one script; returns what the script printed (the result of the step) and the tool events. */
async function runScript(code: string, opts: Parameters<typeof rig>[1] = {}, before?: (r: Rig) => void, said = "go") {
  const r = rig((_req, n) => (n === 0 ? script(HEAD + code) : { text: "done" }), { ...base(executeCode), ...opts });
  before?.(r);
  const events = await r.turn(prompt(said), 20_000);
  const tools = r.of("tool").filter((e) => e.status !== "running");
  const top = tools.find((e) => e.name === "ExecuteCode")!;
  return { r, events, top, nested: tools.filter((e) => e.parent === top.id), output: top.output ?? "" };
}

describe("ExecuteCode is offered only when its switch says so", () => {
  test("it is in the product's tools, marked experimental, and an engine with no switch never offers it", async () => {
    expect(defaultTools().find((t) => t.name === "ExecuteCode")?.experimental).toBe(true);
    const r = rig(() => ({ text: "ok" }));
    await r.turn(prompt("one"));
    expect(r.provider.requests[0]!.tools.map((t) => t.name)).not.toContain("ExecuteCode");
    expect(r.provider.requests[0]!.system).not.toContain("ExecuteCode");
    r.cleanup();
  });

  test("a switch that says on offers it, and one that says off refuses a call to it by name", async () => {
    let on = true;
    const r = rig((_q, n) => (n === 1 ? script(HEAD + "print(1)") : { text: "ok" }), { toolOn: (name) => name !== "ExecuteCode" || on, codeOffer: { mode: "always" } });
    await r.turn(prompt("one"));
    expect(r.provider.requests.at(-1)!.tools.map((t) => t.name)).toContain("ExecuteCode");
    on = false;
    await r.turn(prompt("two"));
    expect(r.provider.requests.at(-1)!.tools.map((t) => t.name)).not.toContain("ExecuteCode");
    r.cleanup();
  });

  test("its text is small: the description and the parameters take at most 900 characters, signatures included", () => {
    expect(executeCode.description.length + JSON.stringify(executeCode.parameters).length).toBeLessThanOrEqual(900);
    for (const sig of ["read(", "grep(", "glob(", "write(", "edit(", "bash(", "web_fetch(", "web_search(", "call_tool("]) expect(executeCode.description).toContain(sig);
  });

  test("it says when to use it and when not to, as the best of the others does", () => {
    expect(executeCode.description).toContain("3 or more tool calls");
    expect(executeCode.description).toContain("1-2 calls");
    expect(executeCode.description).toContain("read in full");
    expect(executeCode.description).toContain("the person must answer");
  });

  test("the model may write the script under another name, or in a fence", () => {
    expect(executeCode.fixArgs!({ script: "print(1)" })).toEqual({ code: "print(1)" });
    expect(executeCode.fixArgs!({ code: "print(1)", script: "x" })).toEqual({ code: "print(1)", script: "x" });
  });
});

describe("a script calls the tools", () => {
  test("every stub gives plain Python values, and each call is a step shown under the script", async () => {
    const { output, nested, r } = await runScript(`
write("a/one.txt", "alpha\\nbeta\\n")
write("a/two.txt", "gamma\\n")
print(repr(read("a/one.txt")))
print(repr(read("a/one.txt", offset=2, limit=2)))
print(sorted(glob("a/*.txt")))
print(sorted(grep("a", "a")))
print(grep("zzz", "a"))
print(edit("a/two.txt", "gamma", "delta").startswith("Edited"))
print(read("a/two.txt").strip())
print(bash("echo hi").strip())
`);
    expect(output).toContain("'alpha\\nbeta'");
    expect(output).toContain("'beta'");
    expect(output).toContain("['a/one.txt', 'a/two.txt']");
    expect(output).toContain("['one.txt:1:alpha', 'one.txt:2:beta', 'two.txt:1:gamma']");
    expect(output).toContain("\n[]\n");
    expect(output).toContain("delta");
    expect(output).toContain("hi");
    expect(nested.map((e) => e.name)).toEqual(["Write", "Write", "Read", "Read", "Glob", "Grep", "Grep", "Edit", "Read", "Bash"]);
    expect(readFileSync(join(r.dir, "a/two.txt"), "utf8")).toBe("delta\n");
    r.cleanup();
  });

  test("web_fetch gives the page without its frame so JSON parses at once, and what the script prints is framed once as web text", async () => {
    const web = Bun.serve({ port: 0, fetch: () => Response.json({ items: [1, 2, 3], next: null }) });
    try {
      const { output, r } = await runScript(`import json\nprint(json.loads(web_fetch("http://127.0.0.1:${web.port}/api"))["items"])`, { allowPrivateNetwork: true }, undefined, "read the page at http://127.0.0.1");
      expect(output).toContain("\n[1, 2, 3]\n");
      expect(output).not.toContain("Page http");
      expect(output.match(/<navvied-web/g)).toHaveLength(1);
      expect(output.trimEnd().endsWith("</navvied-web>")).toBe(true);
      r.cleanup();
    } finally { web.stop(true); }
  });

  test("a failed call raises ToolError with the tool's own words, which a script may catch", async () => {
    const { output, r } = await runScript(`
try:
    read("missing.txt")
except ToolError as e:
    print("caught:", e)
read("missing.txt")
`);
    expect(output).toContain("caught: Error:");
    expect(output).toContain("does not exist");
    expect(output).toContain("ToolError");
    expect(output).toContain("[exit 1]");
    r.cleanup();
  });

  test("the script runs in the project folder", async () => {
    const { output, r } = await runScript("import os\nprint(os.getcwd())");
    expect(output).toContain(r.dir);
    r.cleanup();
  });
});

describe("a script is not a way round the guard", () => {
  test("a dangerous command is stopped by the same rules, and the script is told why", async () => {
    const { output, nested, r } = await runScript(`
try:
    bash("rm -rf /")
except ToolError as e:
    print(e)
`);
    expect(output).toContain("Blocked:");
    expect(nested.find((e) => e.name === "Bash")?.outcome).toBe("blocked");
    r.cleanup();
  });

  test("a permission rule that denies a tool denies it inside a script too", async () => {
    const { output, r } = await runScript(`
try:
    write("x.txt", "no")
except ToolError as e:
    print(e)
`, { rules: new Rules({ allow: [], ask: [], deny: ["Write"] }, process.cwd()) });
    expect(output).toContain("Blocked by the permission rule");
    expect(existsSync(join(r.dir, "x.txt"))).toBe(false);
    r.cleanup();
  });

  test("a call that needs the person's say-so is asked about, step by step, and refused when the person says no", async () => {
    const r = rig((_q, n) => (n === 0 ? script(`${HEAD}\ntry:\n    write("y.txt", "x")\nexcept ToolError as e:\n    print(e)`) : { text: "done" }), { ...base(executeCode) });
    r.send({ cmd: "prompt", text: "go", mode: "ask" });
    await until(() => r.of("approval").length >= 1);
    expect(r.of("approval")[0]!.title).toContain("Run script");
    r.send({ cmd: "approve", id: r.of("approval")[0]!.id, optionId: "allow" });
    await until(() => r.of("approval").length >= 2);
    expect(r.of("approval")[1]!.title).toContain("Write file");
    r.send({ cmd: "approve", id: r.of("approval")[1]!.id, optionId: "deny" });
    await r.engine.idle();
    expect(existsSync(join(r.dir, "y.txt"))).toBe(false);
    expect(r.of("tool").find((e) => e.name === "ExecuteCode" && e.status === "done")?.output).toContain("denied");
    r.cleanup();
  });

  test("a script cannot read a secret: the file's secret is a mark, and what the script prints is cleaned too", async () => {
    const key = "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUV";
    const { output, r } = await runScript(`
print(read("conf.txt"))
print(open("conf.txt").read())
print(bash("cat conf.txt"))
print(grep("token", "."))
`, {}, (x) => writeFileSync(join(x.dir, "conf.txt"), `token = ${key}\n`));
    expect(output).not.toContain(key);
    expect(output).toContain("[hidden");
    r.cleanup();
  });

  test("the script's environment has no variable whose name or value is a secret", async () => {
    process.env.NAVVIED_TEST_API_KEY = "value-of-the-test-key-1";
    process.env.INNOCENT_NAME = "value-of-the-test-key-1";
    process.env.PLAIN_SETTING = "kept";
    try {
      const { output, r } = await runScript(`import os\nprint(sorted(k for k in os.environ if k.startswith(("NAVVIED_TEST", "INNOCENT", "PLAIN"))))`);
      expect(output).toContain("PLAIN_SETTING");
      expect(output).not.toContain("NAVVIED_TEST_API_KEY");
      expect(output).not.toContain("INNOCENT_NAME");
      r.cleanup();
    } finally { delete process.env.NAVVIED_TEST_API_KEY; delete process.env.INNOCENT_NAME; delete process.env.PLAIN_SETTING; }
  });

  test("a script reaches only the tools the model was offered: not the script tool itself, not a tool that does not exist", async () => {
    const { output, r } = await runScript(`
for name in ("ExecuteCode", "NoSuchTool", ""):
    try:
        call_tool(name, code="print(1)")
    except ToolError as e:
        print(str(e)[:60])
`);
    expect(output).toContain("a script cannot call ExecuteCode");
    expect(output).toContain("a script cannot call NoSuchTool");
    expect(output).toContain("a script cannot call that");
    r.cleanup();
  });

  test("a tool the model is not offered is not reached, though the engine knows it", async () => {
    const hidden = { name: "Hidden", readOnly: true, description: "x", parameters: { type: "object", properties: {} }, offeredWhen: () => false, title: () => "Hidden", run: async () => "secret reach" } as Tool;
    const { output, r } = await runScript(`
try:
    print(call_tool("Hidden"))
except ToolError as e:
    print(str(e)[:40])
`, { ...base(executeCode, hidden) });
    expect(output).toContain("a script cannot call Hidden");
    expect(output).not.toContain("secret reach");
    r.cleanup();
  });
});

describe("a script calls the tools of a connected program", () => {
  const FAKE = join(import.meta.dir, "fake-mcp.js");

  test("call_tool reaches them, each call is a step under the script, and a failure raises ToolError", async () => {
    const mcp = await connectMcp({ notes: { command: process.execPath, args: [FAKE] } });
    try {
      const { output, nested, r } = await runScript(`
print(call_tool("mcp__notes__echo", text="hi"))
print(call_tool("mcp__notes__add_numbers", a=2, b=3))
try:
    call_tool("mcp__notes__fail")
except ToolError as e:
    print("caught:", e)
`, {}, (rig) => rig.engine.addTools(mcp.tools));
      expect(output).toContain("echo: hi");
      expect(output).toContain("\n5\n");
      expect(output).toContain("caught: Error: it broke");
      expect(nested.map((e) => e.name)).toEqual(["mcp__notes__echo", "mcp__notes__add_numbers", "mcp__notes__fail"]);
      r.cleanup();
    } finally { mcp.close(); }
  });

  test("the same rules apply: a permission rule that denies the tool denies it inside a script", async () => {
    const mcp = await connectMcp({ notes: { command: process.execPath, args: [FAKE] } });
    try {
      const { output, nested, r } = await runScript(`
try:
    call_tool("mcp__notes__echo", text="x")
except ToolError as e:
    print(e)
`, { rules: new Rules({ allow: [], ask: [], deny: ["mcp__notes__echo"] }, process.cwd()) }, (rig) => rig.engine.addTools(mcp.tools));
      expect(output).toContain("Blocked");
      expect(nested.find((e) => e.name === "mcp__notes__echo")?.outcome).toBe("blocked");
      r.cleanup();
    } finally { mcp.close(); }
  });
});

describe("limits", () => {
  test("the call budget: the call after the last one is not run, and the script is told", async () => {
    const tool = executeCodeTool({ seconds: 20, calls: 3, stdout: 50_000 });
    const { output, nested, r } = await runScript(`
for i in range(5):
    try:
        write(f"f{i}.txt", "x")
        print("wrote", i)
    except ToolError as e:
        print("refused", i, str(e)[:60])
`, { ...base(tool) });
    expect(output.match(/wrote/g)?.length).toBe(3);
    expect(output.match(/refused/g)?.length).toBe(2);
    expect(output).toContain("has made its 3 tool calls");
    expect(nested.length).toBe(3);
    expect(existsSync(join(r.dir, "f3.txt"))).toBe(false);
    r.cleanup();
  });

  test("the time limit stops the script and everything it started, and says so", async () => {
    const tool = executeCodeTool({ seconds: 1, calls: 50, stdout: 50_000 });
    const r = rig((_q, n) => (n === 0 ? script(`import subprocess, sys\nchild = subprocess.Popen(["sleep", "30"])\nopen("pid.txt", "w").write(str(child.pid))\nprint("started", flush=True)\nimport time\ntime.sleep(60)`) : { text: "done" }), { ...base(tool) });
    const t0 = Date.now();
    await r.turn(prompt("go"), 20_000);
    const step = r.of("tool").find((e) => e.name === "ExecuteCode" && e.status !== "running")!;
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(step.output).toContain("started");
    expect(step.output).toContain("[timed out after 1 s and stopped; the variables are gone]");
    expect(step.status).toBe("error");
    const pid = Number(readFileSync(join(r.dir, "pid.txt"), "utf8"));
    const alive = (): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
    await until(() => !alive());
    r.cleanup();
  });

  test("a long output keeps its start and its end, and the whole of it is in a file the model can read", async () => {
    const tool = executeCodeTool({ seconds: 20, calls: 50, stdout: 1_000 });
    const { output, r } = await runScript(`
import sys
for i in range(2000): print("line", i)
`, { ...base(tool) });
    expect(output).toContain("line 0\n");
    expect(output).toContain("line 1999");
    expect(output).toContain("characters omitted");
    const saved = /saved in (\S+):/.exec(output)![1]!;
    expect(readFileSync(saved, "utf8")).toContain("line 1000\n");
    r.cleanup();
  });

  test("an empty script and a missing interpreter are said plainly", async () => {
    const r = rig(() => ({ text: "ok" }), { ...base(executeCode) });
    const noCall = await executeCode.run({ code: "print(1)" }, { cwd: r.dir, signal: new AbortController().signal, emit: () => undefined } as never);
    expect(noCall).toContain("cannot call tools here");
    const empty = await executeCode.run({ code: "  " }, { cwd: r.dir, signal: new AbortController().signal, emit: () => undefined } as never);
    expect(empty).toContain("the script is empty");
    r.cleanup();
  });
});

test("the turn that stops takes the running script with it", async () => {
  const r = rig((_q, n) => (n === 0 ? script(`import time\nprint("up", flush=True)\ntime.sleep(60)`) : { text: "done" }), { ...base(executeCode) });
  r.send(prompt("go"));
  await until(() => r.of("tool").some((e) => e.name === "ExecuteCode" && e.live?.includes("up")));
  r.send({ cmd: "cancel" });
  await r.engine.idle();
  expect(r.of("tool").find((e) => e.name === "ExecuteCode" && e.status !== "running")?.outcome).toBe("stopped");
  r.cleanup();
});

describe("the Python program stays up for the conversation", () => {
  const twice = (first: string, second: string, opts: Parameters<typeof rig>[1] = {}) => {
    const r = rig((req, n) => (n === 0 ? script(HEAD + first) : n === 1 ? script(HEAD + second) : { text: "done" }), { ...base(executeCode), ...opts });
    return r;
  };
  const results = (r: Rig): string[] => r.of("tool").filter((e) => e.name === "ExecuteCode" && e.status !== "running").map((e) => e.output ?? "");

  test("variables, imports and loaded data survive from one script to the next", async () => {
    const r = twice(`data = [1, 2, 3]\nimport math\nprint("loaded")`, `print(sum(data), math.sqrt(16))`);
    await r.turn(prompt("go", { mode: "auto" }), 20_000);
    expect(results(r)).toEqual(["loaded", "6 4.0"]);
    r.cleanup();
  });

  test("reset starts with no variables, and a script that stops the program says the variables are gone", async () => {
    const r = rig((_q, n) => (n === 0 ? script(HEAD + "x = 1") : n === 1 ? { calls: [{ name: "ExecuteCode", args: { code: HEAD + "print('x' in globals())", reset: true } }] } : n === 2 ? script(HEAD + "x = 2\nimport os\nos._exit(3)") : n === 3 ? script(HEAD + "print('x' in globals())") : { text: "done" }), { ...base(executeCode) });
    await r.turn(prompt("go", { mode: "auto" }), 20_000);
    const out = results(r);
    expect(out[1]).toBe("False");
    expect(out[2]).toContain("[the Python program ended; the variables are gone]");
    expect(out[3]).toContain("[the Python program was started again: earlier variables are gone]");
    expect(out[3]).toContain("False");
    r.cleanup();
  });

  test("a script that fails leaves what it had made, and its traceback starts at the script", async () => {
    const r = twice(`kept = 7\nraise ValueError("nope")`, `print(kept)`);
    await r.turn(prompt("go", { mode: "auto" }), 20_000);
    const out = results(r);
    expect(out[0]).toContain("ValueError: nope");
    expect(out[0]).toContain("[exit 1]");
    expect(out[0]).not.toContain("exec(compile");
    expect(out[1]).toBe("7");
    r.cleanup();
  });

  test("call_tool gives parsed JSON when the result is JSON, and the program ends with the conversation", async () => {
    const json = Bun.serve({ port: 0, fetch: () => Response.json({ items: [1, 2] }) });
    try {
      const r = twice(`import os\nopen("pid.txt", "w").write(str(os.getpid()))\nprint(type(call_tool("WebFetch", url="http://127.0.0.1:${json.port}/x")).__name__)`, `print(call_tool("Read", file_path="pid.txt"))`, { allowPrivateNetwork: true });
      await r.turn(prompt("fetch http://127.0.0.1 and read pid.txt", { mode: "auto" }), 20_000);
      expect(results(r)[0]).toContain("\ndict\n");
      const pid = Number(readFileSync(join(r.dir, "pid.txt"), "utf8"));
      const alive = (): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
      expect(alive()).toBe(true);
      r.cleanup();
      await until(() => !alive(), 5_000);
      expect(alive()).toBe(false);
    } finally { json.stop(true); }
  });
});
