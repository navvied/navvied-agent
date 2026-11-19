import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Jobs, connectMcp, McpClient, defaultTools } from "../src/index.ts";
import type { Tool, ToolContext } from "../src/types.ts";
import { toolsFor } from "../src/permissions.ts";
import { rig, prompt, cleanupAll, until } from "./helpers.ts";
import { stopAllJobs } from "../src/index.ts";
import { hook, removeTree } from "../../protocol/test/support/cleanup.ts";

const FAKE = join(import.meta.dir, "fake-mcp.js");
const dir = mkdtempSync(join(tmpdir(), "navvied-mcp-"));
const jobs = new Jobs(() => {});
afterAll(hook("mcp removes what it made", async () => { await stopAllJobs(); await removeTree(dir); jobs.close(); await cleanupAll(); }));
const server = (env: Record<string, string> = {}) => ({ command: process.execPath, args: [FAKE], env });
const ctx = (signal = new AbortController().signal): ToolContext => ({ cwd: dir, signal, emit: () => {}, allowPrivateNetwork: false, jobs });
const find = (tools: Tool[], name: string): Tool => tools.find((t) => t.name === name)!;

describe("connected programs", () => {
  test("their tools join the engine's, named by server and tool, with the program's own description and schema", async () => {
    const mcp = await connectMcp({ notes: server() });
    try {
      expect(mcp.problems).toEqual([]);
      expect(mcp.tools.map((t) => t.name)).toEqual(["mcp__notes__echo", "mcp__notes__add_numbers", "mcp__notes__fail", "mcp__notes__slow", "mcp__notes__big", "mcp__notes__picture"]);
      const echo = find(mcp.tools, "mcp__notes__echo");
      expect(echo.description).toContain("Say it back");
      expect(echo.description).toContain('connected program "notes"');
      expect(echo.parameters).toMatchObject({ type: "object", properties: { text: { type: "string" } }, required: ["text"] });
      expect(find(mcp.tools, "mcp__notes__fail").parameters).toMatchObject({ type: "object", properties: {} });
      expect(echo.readOnly).toBe(true);
      expect(find(mcp.tools, "mcp__notes__add_numbers").readOnly).toBe(false);
      expect(echo.title({})).toBe("notes: echo");
    } finally { mcp.close(); }
  });

  test("a call goes through and its text comes back; a failure is an Error: line; other content is named, not shown", async () => {
    const mcp = await connectMcp({ notes: server() });
    try {
      expect(await find(mcp.tools, "mcp__notes__echo").run({ text: "hi" }, ctx())).toBe("echo: hi");
      expect(await find(mcp.tools, "mcp__notes__add_numbers").run({ a: 2, b: 3 }, ctx())).toBe("5");
      expect(await find(mcp.tools, "mcp__notes__fail").run({}, ctx())).toBe("Error: it broke");
      expect(await find(mcp.tools, "mcp__notes__picture").run({}, ctx())).toBe("[image omitted]\nhere");
      expect((await find(mcp.tools, "mcp__notes__big").run({}, ctx())).length).toBeLessThan(31_000);
    } finally { mcp.close(); }
  });

  test("stopping the turn stops the wait, tells the server, and leaves it usable", async () => {
    const log = join(dir, "cancel.log");
    const mcp = await connectMcp({ notes: server({ CANCEL_LOG: log }) });
    try {
      const stop = new AbortController();
      const slow = find(mcp.tools, "mcp__notes__slow").run({}, ctx(stop.signal));
      setTimeout(() => stop.abort(), 50);
      expect(await slow).toBe("Error: [interrupted]");
      await until(() => existsSync(log));
      expect(readFileSync(log, "utf8").trim()).toMatch(/^\d+$/);
      expect(await find(mcp.tools, "mcp__notes__echo").run({ text: "still here" }, ctx())).toBe("echo: still here");
    } finally { mcp.close(); }
  });

  test("a long list of tools is read page by page", async () => {
    const mcp = await connectMcp({ notes: server({ FAKE_MODE: "paged" }) });
    try { expect(mcp.tools).toHaveLength(6); } finally { mcp.close(); }
  });

  test("one program that cannot start does not stop the others, and the reason is plain", async () => {
    const mcp = await connectMcp({ good: server(), missing: { command: "navvied-no-such-program" }, crashes: server({ FAKE_MODE: "crash" }) });
    try {
      expect(mcp.tools.some((t) => t.name.startsWith("mcp__good__"))).toBe(true);
      const reasons = Object.fromEntries(mcp.problems.map((p) => [p.server, p.reason]));
      expect(reasons.missing).toContain("could not start");
      expect(Object.keys(reasons).sort()).toEqual(["crashes", "missing"].filter((k) => k in reasons));
    } finally { mcp.close(); }
  });

  test("a program that never answers the handshake is given up on", async () => {
    const started = Date.now();
    const client = McpClient.start("silent", server({ FAKE_MODE: "silent" }));
    const stop = setTimeout(() => {}, 0);
    clearTimeout(stop);
    await Promise.race([client.then(() => "connected", (e: Error) => e.message), new Promise((r) => setTimeout(() => r("still waiting"), 1000))]).then((v) => expect(v).toBe("still waiting"));
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    client.then((c) => c.close(), () => undefined);
  });

  test("a call to a program that has ended says so", async () => {
    const mcp = await connectMcp({ notes: server() });
    const echo = find(mcp.tools, "mcp__notes__echo");
    mcp.close();
    expect(await echo.run({ text: "x" }, ctx())).toMatch(/^Error: /);
  });

  test("a small model is shown a program's tools only when the request names the program or the tool", async () => {
    const mcp = await connectMcp({ notes: server() }, true);
    try {
      const names = (userText: string, small: boolean) => toolsFor("auto", [...defaultTools(), ...mcp.tools], { small, userText, jobs: 0 }).map((t) => t.name).filter((n) => n.startsWith("mcp__"));
      expect(names("fix the bug", true)).toEqual([]);
      expect(names("add a note in notes", true)).toHaveLength(6);
      expect(names("use echo please", true)).toEqual(["mcp__notes__echo"]);
      expect(names("fix the bug", false)).toHaveLength(6);
    } finally { mcp.close(); }
  });
});

describe("the engine with a connected program", () => {
  test("the model can call its tool, and closing the engine stops the program", async () => {
    const mcp = await connectMcp({ notes: server() });
    const r = rig((req) => {
      if (req.messages.at(-1)?.role === "tool") return { text: `got: ${String(req.messages.at(-1)!.content)}` };
      return { calls: [{ name: "mcp__notes__echo", args: { text: "from the model" } }] };
    });
    r.engine.addTools(mcp.tools, () => mcp.close());
    await r.turn(prompt("use the notes program"));
    expect(r.of("tool").some((e) => e.name === "mcp__notes__echo" && e.status === "done" && e.output === "echo: from the model")).toBe(true);
    expect(r.text()).toContain("got: echo: from the model");
    r.engine.close();
    expect(await find(mcp.tools, "mcp__notes__echo").run({ text: "x" }, ctx())).toMatch(/^Error: /);
    r.cleanup();
  });
  test("a program that cannot start is a notice, not an error, and the turn still runs with the others", async () => {
    const r = rig(() => ({ text: "fine" }));
    r.engine.loadTools(connectMcp({ good: server(), missing: { command: "navvied-no-such-program" } }));
    await r.turn(prompt("go"));
    const notice = r.of("notice")[0]!;
    expect(notice.msg).toContain('The connected program "missing" could not be used: could not start');
    expect(r.of("error")).toEqual([]);
    expect(r.of("done").at(-1)!.stop).toBe("end_turn");
    r.engine.close();
    r.cleanup();
  });
  test.skipIf(process.platform === "win32")("closing the engine while a program is still being connected stops that program, and one that connects after is stopped on arrival", async () => {
    const marker = `navvied-mcp-marker-${Math.random().toString(36).slice(2)}`;
    const alive = (): boolean => Bun.spawnSync(["pgrep", "-f", marker]).stdout.toString().trim() !== "";
    const r = rig(() => ({ text: "x" }));
    r.engine.loadTools(connectMcp({ quiet: { command: process.execPath, args: [FAKE, marker], env: { FAKE_MODE: "silent" } } }, false, r.engine.closing));
    await until(alive);
    r.engine.close();
    await until(() => !alive(), 3000);
    const late = rig(() => ({ text: "x" }));
    const marker2 = `${marker}-late`;
    late.engine.close();
    late.engine.loadTools(connectMcp({ notes: { command: process.execPath, args: [FAKE, marker2] } }));
    await Bun.sleep(1500);
    expect(Bun.spawnSync(["pgrep", "-f", marker2]).stdout.toString().trim()).toBe("");
    r.cleanup();
    late.cleanup();
  });
  test("tools are not added twice", () => {
    const r = rig(() => ({ text: "x" }));
    const tool: Tool = { name: "t", readOnly: true, description: "", parameters: { type: "object", properties: {} }, title: () => "t", run: async () => "ok" };
    r.engine.addTools([tool]);
    r.engine.addTools([tool]);
    r.cleanup();
  });
});
