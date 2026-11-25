import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Media, computer, defaultTools } from "@navvied/engine";
import { createHub } from "../src/commands/hub.ts";
import { pluginStatePath } from "../src/config.ts";
import { PluginState } from "../src/plugins.ts";
import { ROW_NEED } from "../src/media-setup.ts";
import { CATEGORIES, TOOL_ROWS, rowOf } from "../src/tool-table.ts";
import { ToolUsage, listEntries, switchRow, toolSwitch } from "../src/tools-info.ts";
import { fakeIO, remove, startMockModel, tempDir, until } from "./helpers.ts";

const dirs: string[] = [];
afterAll(() => { dirs.forEach(remove); });
const state = (): PluginState => { const d = tempDir(); dirs.push(d); return new PluginState(join(d, "plugins.json")); };
const usage = (): ToolUsage => { const d = tempDir(); dirs.push(d); return new ToolUsage(join(d, "usage.json")); };

describe("one switch for each tool a person knows", () => {
  test("the table covers every tool of the engine once, in categories that exist, with ids that are unique", () => {
    const names = TOOL_ROWS.flatMap((r) => [...r.names]);
    expect(new Set(names).size).toBe(names.length);
    for (const t of defaultTools()) expect(rowOf(t.name), t.name).toBeDefined();
    expect(new Set(TOOL_ROWS.map((r) => r.id)).size).toBe(TOOL_ROWS.length);
    for (const r of TOOL_ROWS) expect(CATEGORIES.map((c) => c.id), r.id).toContain(r.category);
  });

  test("the six categories and their rows are the approved ones, with the words as drawn", () => {
    expect(CATEGORIES.map((c) => c.title)).toEqual(["Work", "Browse & research", "Plan & coordinate", "Memory & knowledge", "See, hear & create", "Control the computer"]);
    const titles = (category: string): string[] => TOOL_ROWS.filter((r) => r.category === category).map((r) => r.title);
    expect(titles("work")).toEqual(["Files & Search", "Terminal & Processes", "Code Execution"]);
    expect(titles("browse")).toEqual(["Web Search", "Web Fetch", "Browser Automation"]);
    expect(titles("plan")).toEqual(["Questions", "Task Planning", "Helpers", "Schedule"]);
    expect(titles("memory")).toEqual(["Memory", "Session Search", "Skills"]);
    expect(titles("create")).toEqual(["Vision", "Speech to Text", "Text to Speech", "Image Generation", "Video Generation", "Video Analysis"]);
    expect(titles("computer")).toEqual(["Computer Use"]);
    expect(rowOf("Remember")!.id).toBe("memory");
    expect(rowOf("Recall")!.id).toBe("session-search");
    expect(rowOf("SkillManage")!.id).toBe("skills");
  });

  test("each row says whether it is on, and in what state", () => {
    const entries = listEntries(state(), usage());
    const by = (id: string) => entries.find((e) => e.id === id)!;
    expect(by("files")).toMatchObject({ category: "work", title: "Files & Search", on: true, state: "on", calls: 0 });
    expect(by("terminal")).toMatchObject({ category: "work", on: true, state: "on", names: ["Bash", "BashOutput", "BashInput", "KillShell"] });
    // The tools of these do not exist yet.
    // Computer use exists, but only where a helper drives the screen: without one the engine has no such tool and the row says it is unavailable here.
    expect(by("computer-use")).toMatchObject({ on: true, state: "unavailable-here", names: ["computer"] });
    // The tools of media have a row each, and wait for something to be set up when nothing says they can work.
    for (const id of Object.keys(ROW_NEED)) expect(rowOf(by(id).names[0]!)!.id, id).toBe(id);
    // The experimental tool is experimental on every computer, whether or not this program has it in its list: the switch says whether it is used.
    expect(by("code")).toMatchObject({ on: false, state: "experimental" });
    for (const e of entries) expect(e.setup, e.id).toBeUndefined();
    const order = entries.map((e) => CATEGORIES.findIndex((c) => c.id === e.category));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  test("the experimental tool is listed as experimental, off until it is switched on", () => {
    const s = state();
    const tools = [...defaultTools(), { ...defaultTools()[0]!, name: "ExecuteCode" }];
    expect(listEntries(s, usage(), tools).find((e) => e.id === "code")).toMatchObject({ on: false, state: "experimental" });
    expect(toolSwitch(s)("ExecuteCode")).toBe(false);
    switchRow(s, rowOf("ExecuteCode")!, true);
    expect(listEntries(s, usage(), tools).find((e) => e.id === "code")).toMatchObject({ on: true, state: "experimental" });
    expect(toolSwitch(s)("ExecuteCode")).toBe(true);
  });

  test("a row that is off says off; a row waiting for something says needs-setup; the computer can say a row is not here", () => {
    const s = state();
    switchRow(s, rowOf("Recall")!, false);
    const entries = listEntries(s, usage(), defaultTools(), (row) => (row.id === "browser" ? "needs-setup" : row.id === "files" ? "unavailable-here" : undefined));
    const by = (id: string) => entries.find((e) => e.id === id)!;
    expect(by("session-search")).toMatchObject({ on: false, state: "off" });
    expect(by("memory")).toMatchObject({ on: true, state: "on" });
    expect(by("browser")).toMatchObject({ on: true, state: "needs-setup" });
    expect(by("files")).toMatchObject({ state: "unavailable-here" });
    expect(listEntries(s, usage(), defaultTools(), () => undefined, new Set(["browser"])).find((e) => e.id === "browser")).toMatchObject({ setup: true });
  });

  test("calls are counted for all the tools of a row", () => {
    const u = usage();
    u.add("Bash"); u.add("BashOutput"); u.add("Read"); u.add("Grep");
    const entries = listEntries(state(), u);
    expect(entries.find((e) => e.id === "terminal")!.calls).toBe(2);
    expect(entries.find((e) => e.id === "files")!.calls).toBe(2);
  });

  test("switching a row takes back what its single tools said before, and a tool with no row is always allowed", () => {
    const s = state();
    s.set("tool:Bash", false);
    expect(toolSwitch(s)("Bash")).toBe(false);
    expect(toolSwitch(s)("BashOutput")).toBe(true);
    switchRow(s, rowOf("Bash")!, false);
    expect(s.disabled().has("tool:Bash")).toBe(false);
    expect(["Bash", "BashOutput", "BashInput", "KillShell"].map(toolSwitch(s))).toEqual([false, false, false, false]);
    switchRow(s, rowOf("Bash")!, true);
    expect(toolSwitch(s)("Bash")).toBe(true);
    expect(toolSwitch(s)("mcp__notes__find")).toBe(true);
  });
});

describe("every tool's state on a computer with a browser and nothing switched", () => {
  test("is the state of the approved Tools screen, tool by tool", () => {
    const nothing = new Media({ which: () => undefined });
    const states = Object.fromEntries(listEntries(state(), usage(), defaultTools(), (row) => (ROW_NEED[row.id] && !nothing.has(ROW_NEED[row.id]!) ? "needs-setup" : undefined)).map((e) => [e.id, e.state]));
    expect(states).toEqual({
      files: "on", terminal: "on", code: "experimental",
      "web-search": "on", "web-fetch": "on", browser: "on",
      ask: "on", todo: "on", helpers: "on", schedule: "on",
      memory: "on", "session-search": "on", skills: "on",
      vision: "needs-setup", "speech-to-text": "needs-setup", "text-to-speech": "needs-setup", image: "needs-setup", "video-generation": "needs-setup", "video-analysis": "needs-setup",
      "computer-use": "unavailable-here",
    });
    expect(Object.keys(states)).toHaveLength(20);
  });

  test("computer use is on once the engine has the tool, waits for a permission when the host says so, and is refused by name when switched off", () => {
    const s = state();
    const tools = [...defaultTools(), computer];
    expect(listEntries(s, usage(), tools).find((e) => e.id === "computer-use")).toMatchObject({ on: true, state: "on" });
    expect(listEntries(s, usage(), tools, (row) => (row.id === "computer-use" ? "needs-setup" : undefined)).find((e) => e.id === "computer-use")).toMatchObject({ state: "needs-setup" });
    expect(listEntries(s, usage(), tools, (row) => (row.id === "computer-use" ? "unavailable-here" : undefined)).find((e) => e.id === "computer-use")).toMatchObject({ state: "unavailable-here" });
    switchRow(s, rowOf("computer")!, false);
    expect(toolSwitch(s)("computer")).toBe(false);
    expect(listEntries(s, usage(), tools).find((e) => e.id === "computer-use")).toMatchObject({ on: false, state: "off" });
  });

  test("the browser waits for a browser to be found, and says so only then", () => {
    const entries = listEntries(state(), usage(), defaultTools(), (row) => (row.id === "browser" ? "needs-setup" : undefined));
    expect(entries.find((e) => e.id === "browser")).toMatchObject({ on: true, state: "needs-setup" });
    expect(entries.filter((e) => e.state === "needs-setup")).toHaveLength(1);
  });
});

describe("the hub switches one tool at a time and reports every tool", () => {
  test("the report has entries and categories; a row can be switched by its id or by the name of its tool", async () => {
    const mock = startMockModel();
    const home = tempDir(), work = tempDir(); dirs.push(home, work);
    const env = { HOME: home, XDG_STATE_HOME: home, XDG_CONFIG_HOME: home, NAVVIED_BASE_URL: mock.url, NAVVIED_MODEL: "mock-model", NAVVIED_WINDOW: "100000" };
    const hub = createHub({ json: false, yes: false, thinking: false, cwd: work } as never, fakeIO({ env }).io, { watch: false });
    const got: { ev: string; [k: string]: unknown }[] = [];
    hub.attach({ send: (line) => { got.push(JSON.parse(String(line))); } }, 0);
    const send = (cmd: object): void => hub.command(JSON.stringify(cmd), () => undefined);
    type Entry = { id: string; on: boolean; state: string };
    const last = () => got.filter((e) => e.ev === "tools").at(-1) as unknown as { entries: Entry[]; categories: { id: string; title: string }[] };
    send({ cmd: "tools" });
    await until(() => got.some((e) => e.ev === "tools"));
    expect(last().categories).toEqual(CATEGORIES.map((c) => ({ ...c })));
    expect(last().entries.find((e) => e.id === "memory")).toMatchObject({ on: true, state: "on" });
    // Nothing is set up for media on this computer: its rows say so and cannot be switched on until it is.
    for (const id of Object.keys(ROW_NEED)) expect(last().entries.find((e) => e.id === id), id).toMatchObject({ on: true, state: "needs-setup" });
    send({ cmd: "tool.toggle", name: "session-search", enabled: false });
    await until(() => last().entries.find((e) => e.id === "session-search")!.on === false || got.some((e) => e.ev === "error"));
    expect(got.filter((e) => e.ev === "error")).toEqual([]);
    expect(last().entries.find((e) => e.id === "memory")!.on).toBe(true);
    send({ cmd: "tool.toggle", name: "Remember", enabled: false });
    await until(() => last().entries.find((e) => e.id === "memory")!.on === false);
    expect(last().entries.find((e) => e.id === "session-search")!.on).toBe(false);
    expect(new PluginState(pluginStatePath(env)).disabled()).toEqual(new Set(["tool:session-search", "tool:memory"]));
    send({ cmd: "tool.setup", id: "browser" });
    await until(() => got.some((e) => e.ev === "error" && e.msg === "That tool has nothing to set up."));
    await hub.stop();
    mock.stop();
  });
});
