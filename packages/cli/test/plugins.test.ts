import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHub } from "../src/commands/hub.ts";
import { configPath, pluginStatePath } from "../src/config.ts";
import { PluginState, activeHooks, activeSkills, hookId, skillId } from "../src/plugins.ts";
import { fakeIO, remove, startMockModel, tempDir, until } from "./helpers.ts";

let mock: ReturnType<typeof startMockModel>;
const dirs: string[] = [];
beforeAll(() => { mock = startMockModel(); });
afterAll(() => { mock.stop(); dirs.forEach(remove); });

type Ev = { ev: string; [k: string]: unknown };
type Item = { id: string; kind: string; name: string; description: string; enabled: boolean; source: string; fromNext?: boolean };

function open() {
  const state = tempDir(), work = tempDir();
  dirs.push(state, work);
  const env = { HOME: state, XDG_STATE_HOME: state, XDG_CONFIG_HOME: state, NAVVIED_BASE_URL: mock.url, NAVVIED_MODEL: "mock-model", NAVVIED_WINDOW: "100000" };
  mkdirSync(join(dirname(configPath(env)), "skills", "changelog"), { recursive: true });
  writeFileSync(join(dirname(configPath(env)), "skills", "changelog", "SKILL.md"), "---\nname: changelog\ndescription: Write a changelog from the commits\n---\nStep one.\n");
  writeFileSync(configPath(env), JSON.stringify({ models: {}, mcp: { files: { command: "node", args: ["server.js"] }, web: { url: "https://tools.example.com/mcp" } }, hooks: { PreToolUse: [{ matcher: "Bash", command: "echo checking" }, { command: "echo second" }] } }));
  const hub = createHub({ json: false, yes: false, thinking: false, cwd: work } as never, fakeIO({ env }).io, { watch: false });
  const got: Ev[] = [];
  hub.attach({ send: (line) => { got.push(JSON.parse(String(line))); } }, 0);
  const send = (cmd: object): void => hub.command(JSON.stringify(cmd), () => undefined);
  const last = (): Item[] => (got.filter((e) => e.ev === "plugins").at(-1) as unknown as { items: Item[] }).items;
  return { env, hub, got, send, last };
}

describe("what extends the agent here", () => {
  test("skills, outside tool servers and hooks are listed read-only, each with where it comes from and whether it is on", async () => {
    const { hub, got, send, last } = open();
    expect((got.find((e) => e.ev === "caps") as unknown as { plugins?: boolean }).plugins).toBe(true);
    send({ cmd: "plugins" });
    await until(() => got.some((e) => e.ev === "plugins"));
    const items = last();
    expect(items.find((i) => i.id === "skill:changelog")).toMatchObject({ kind: "skill", name: "changelog", description: "Write a changelog from the commits", source: "user", enabled: true });
    expect(items.find((i) => i.id === "skill:changelog")!.fromNext).toBeUndefined();
    expect(items.find((i) => i.id === "mcp:files")).toMatchObject({ kind: "mcp", source: "config", enabled: true, fromNext: true });
    expect(items.find((i) => i.id === "mcp:web")!.description).toContain("tools.example.com");
    expect(items.filter((i) => i.kind === "hook").map((i) => [i.id, i.name])).toEqual([["hook:PreToolUse:0", "PreToolUse (Bash)"], ["hook:PreToolUse:1", "PreToolUse"]]);
    await hub.stop();
  });

  test("switching one off is kept on the computer, told to every window, and the configuration file is not touched; an unknown one is refused", async () => {
    const { env, hub, got, send, last } = open();
    const before = (await import("node:fs")).readFileSync(configPath(env), "utf8");
    send({ cmd: "plugin.toggle", id: "skill:changelog", enabled: false });
    await until(() => got.some((e) => e.ev === "plugins"));
    expect(last().find((i) => i.id === "skill:changelog")!.enabled).toBe(false);
    send({ cmd: "plugin.toggle", id: "hook:PreToolUse:0", enabled: false });
    await until(() => last().find((i) => i.id === "hook:PreToolUse:0")?.enabled === false);
    expect(last().find((i) => i.id === "hook:PreToolUse:1")!.enabled).toBe(true);
    expect([...new PluginState(pluginStatePath(env)).disabled()].sort()).toEqual(["hook:PreToolUse:0", "skill:changelog"]);
    expect((await import("node:fs")).readFileSync(configPath(env), "utf8")).toBe(before);
    send({ cmd: "plugin.toggle", id: "skill:changelog", enabled: true });
    await until(() => last().find((i) => i.id === "skill:changelog")?.enabled === true);
    send({ cmd: "plugin.toggle", id: "skill:nothing", enabled: false });
    await until(() => got.some((e) => e.ev === "error"));
    expect(got.find((e) => e.ev === "error")!.msg).toBe("That is not installed on this computer.");
    await hub.stop();
  });

  test("what is switched off is left out of what the agent uses", () => {
    const state = new PluginState(pluginStatePath({ XDG_STATE_HOME: tempDir() }));
    dirs.push(dirname(pluginStatePath({ XDG_STATE_HOME: "/x" })));
    const skills = tempDir(); dirs.push(skills);
    mkdirSync(join(skills, "a"), { recursive: true }); mkdirSync(join(skills, "b"), { recursive: true });
    writeFileSync(join(skills, "a", "SKILL.md"), "---\nname: a\ndescription: first\n---\nx");
    writeFileSync(join(skills, "b", "SKILL.md"), "---\nname: b\ndescription: second\n---\nx");
    expect(activeSkills(state, { user: skills }).map((s) => s.name).sort()).toEqual(["a", "b"]);
    state.set(skillId("a"), false);
    expect(activeSkills(state, { user: skills }).map((s) => s.name)).toEqual(["b"]);
    state.set(hookId("PreToolUse", 0), false);
    const hooks = { PreToolUse: [{ command: "one" }, { command: "two" }], Stop: [{ command: "stop" }] };
    expect(activeHooks(state, hooks)).toEqual({ PreToolUse: [{ command: "two" }], Stop: [{ command: "stop" }] });
    state.set(hookId("Stop", 0), false);
    state.set(hookId("PreToolUse", 1), false);
    expect(activeHooks(state, hooks)).toBeUndefined();
  });
});
