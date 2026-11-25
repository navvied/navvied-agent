import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { defaultTools } from "@navvied/engine";
import { createHub } from "../src/commands/hub.ts";
import { pluginStatePath } from "../src/config.ts";
import { PluginState } from "../src/plugins.ts";
import { terminalStatePath, toolUsagePath } from "../src/config.ts";
import { TerminalState, backendFor, listBackends } from "../src/terminal.ts";
import { ToolUsage, activeTools, listSets, listTools } from "../src/tools-info.ts";
import { fakeIO, remove, startMockModel, tempDir, until } from "./helpers.ts";

let mock: ReturnType<typeof startMockModel>;
const dirs: string[] = [];
beforeAll(() => { mock = startMockModel(); });
afterAll(() => { mock.stop(); dirs.forEach(remove); });

const usage = (dir: string) => new ToolUsage(join(dir, "usage.json"));

describe("the tools of the agent", () => {
  test("every tool is listed once, in plain words, and gathered into sets", () => {
    const dir = tempDir(); dirs.push(dir);
    const items = listTools(new PluginState(join(dir, "plugins.json")), usage(dir));
    expect(items.map((t) => t.name)).toEqual(defaultTools().map((t) => t.name));
    expect(items.find((t) => t.name === "Bash")).toMatchObject({ title: "Run commands", access: "run", core: true, small: true, enabled: true, calls: 0, set: "terminal" });
    expect(items.filter((t) => t.small).map((t) => t.name).sort()).toEqual(["Bash", "Edit", "Glob", "Grep", "Read", "Write"]);
    for (const t of items) expect(t.about.length).toBeGreaterThan(5);
    const sets = listSets(items);
    expect(sets.find((x) => x.id === "terminal")).toMatchObject({ title: "Terminal & Processes", tools: ["Bash", "BashOutput", "BashInput", "KillShell"], enabled: true, calls: 0 });
    expect(sets.flatMap((x) => x.tools).sort()).toEqual(items.map((t) => t.name).sort());
  });

  test("calls are counted and kept", () => {
    const dir = tempDir(); dirs.push(dir);
    const u = usage(dir);
    u.add("Bash"); u.add("Bash"); u.add("Read");
    const again = usage(dir);
    expect(again.counts()).toEqual({ Bash: 2, Read: 1 });
    expect(listSets(listTools(new PluginState(join(dir, "p.json")), again)).find((x) => x.id === "terminal")!.calls).toBe(2);
  });

  test("a tool that is switched off is not given to a new conversation", () => {
    const dir = tempDir(); dirs.push(dir);
    const state = new PluginState(join(dir, "plugins.json"));
    state.set("tool:Bash", false);
    state.set("tool:WebFetch", false);
    const names = activeTools(state).map((t) => t.name);
    expect(names).not.toContain("Bash");
    expect(names).not.toContain("WebFetch");
    expect(names).toContain("Read");
    expect(listTools(state, usage(dir)).find((t) => t.name === "Bash")!.enabled).toBe(false);
  });

  test("the places commands can run say whether they can be used, and what to do when not", () => {
    const dir = tempDir(); dirs.push(dir);
    const state = new TerminalState(join(dir, "terminal.json"));
    // What the computer has is told to the code, not asked of it: starting Docker can take seconds on some systems.
    const nothing = (): boolean => false;
    const none = listBackends(state, undefined, nothing);
    expect(none.map((b) => b.id)).toEqual(["local", "docker", "ssh"]);
    expect(none[0]).toMatchObject({ ready: true, using: true });
    expect(none[1]).toMatchObject({ ready: false });
    expect(none[2]).toMatchObject({ ready: false, using: false });
    expect(none[2]!.hint).toContain("config.json");
    expect(listBackends(state, { ssh: { host: "example.test" } }, nothing)[2]!.hint).toContain("ssh program");
    expect(listBackends(state, undefined, (p) => p === "podman")[1]).toMatchObject({ ready: true });
    expect(listBackends(state, { ssh: { host: "example.test" } }, (p) => p === "ssh")[2]).toMatchObject({ ready: true });
    // Choosing a place that cannot be used falls back to this computer.
    state.set("ssh");
    expect(backendFor(state, undefined, nothing).id).toBe("local");
    expect(backendFor(state, { ssh: { host: "example.test" } }, nothing).id).toBe("ssh");
    expect(backendFor(state, { ssh: { host: "example.test", user: "me", dir: "/srv/app" } }, nothing).prepare("ls", "/w").argv.slice(-2)).toEqual(["me@example.test", "cd '/srv/app' && ls"]);
    state.set("docker");
    expect(backendFor(state, undefined, nothing).id).toBe("local");
    expect(backendFor(state, undefined, (p) => p === "docker").id).toBe("docker");
  });

  test("the hub lists tools, sets and places, switches a tool or a whole set, and says no to what it does not have", async () => {
    const state = tempDir(), work = tempDir(); dirs.push(state, work);
    const env = { HOME: state, XDG_STATE_HOME: state, XDG_CONFIG_HOME: state, NAVVIED_BASE_URL: mock.url, NAVVIED_MODEL: "mock-model", NAVVIED_WINDOW: "100000" };
    const hub = createHub({ json: false, yes: false, thinking: false, cwd: work } as never, fakeIO({ env }).io, { watch: false });
    const got: { ev: string; [k: string]: unknown }[] = [];
    hub.attach({ send: (line) => { got.push(JSON.parse(String(line))); } }, 0);
    const send = (cmd: object): void => hub.command(JSON.stringify(cmd), () => undefined);
    type Tools = { items: { name: string; enabled: boolean }[]; sets: { id: string; enabled: boolean }[]; backends: { id: string; using: boolean }[] };
    const last = () => got.filter((e) => e.ev === "tools").at(-1) as unknown as Tools;
    send({ cmd: "tools" });
    await until(() => got.some((e) => e.ev === "tools"));
    expect(last().items.find((t) => t.name === "Browser")!.enabled).toBe(true);
    expect(last().backends.find((b) => b.using)!.id).toBe("local");
    send({ cmd: "tool.toggle", name: "Browser", enabled: false });
    await until(() => last().items.find((t) => t.name === "Browser")!.enabled === false);
    expect(new PluginState(pluginStatePath(env)).disabled().has("tool:browser")).toBe(true);
    send({ cmd: "tool.toggle", name: "terminal", enabled: false });
    await until(() => last().sets.find((x) => x.id === "terminal")!.enabled === false);
    expect(last().items.filter((t) => ["Bash", "BashOutput", "BashInput", "KillShell"].includes(t.name)).every((t) => !t.enabled)).toBe(true);
    send({ cmd: "tool.toggle", name: "Nope", enabled: false });
    await until(() => got.some((e) => e.ev === "error" && e.msg === "That tool is not one of the agent's."));
    send({ cmd: "terminal.use", backend: "ssh" });
    await until(() => got.some((e) => e.ev === "error" && String(e.msg).includes("config.json")));
    expect(new TerminalState(terminalStatePath(env)).chosen()).toBe("local");
    expect(got.find((e) => e.ev === "caps")).toMatchObject({ toolList: true });
    expect(toolUsagePath(env)).toContain("tool-usage.json");
    await hub.stop();
  });
});

describe("the agent can look through earlier conversations", () => {
  const ask = async (text: string): Promise<string[]> => {
    const state = tempDir(), work = tempDir(); dirs.push(state, work);
    const env = { HOME: state, XDG_STATE_HOME: state, XDG_CONFIG_HOME: state, NAVVIED_BASE_URL: mock.url, NAVVIED_MODEL: "mock-model", NAVVIED_WINDOW: "100000" };
    const hub = createHub({ json: false, yes: false, thinking: false, cwd: work } as never, fakeIO({ env }).io, { watch: false });
    const got: { ev: string }[] = [];
    hub.attach({ send: (line) => { got.push(JSON.parse(String(line))); } }, 0);
    hub.command(JSON.stringify({ cmd: "prompt", text, qid: "q1" }), () => undefined);
    await until(() => got.some((e) => e.ev === "done"));
    await hub.stop();
    return ((mock.requests.at(-1)?.body.tools ?? []) as { function: { name: string } }[]).map((t) => t.function.name);
  };
  test("the tool is given to the model when the person refers to something from before", async () => {
    expect(await ask("what did we decide last time about the login page?")).toContain("Recall");
  });
  test("and not otherwise, so a small model is not given one more thing to choose from", async () => {
    expect(await ask("rename the variable x to y in src/a.ts")).not.toContain("Recall");
  });
});
