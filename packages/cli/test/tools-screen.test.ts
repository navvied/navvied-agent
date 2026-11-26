import { describe, expect, test } from "bun:test";
import type { BackendInfo, EngineEvent, ToolEntry, ToolInfo } from "@navvied/protocol";
import { CATEGORIES, TOOL_ROWS } from "../src/tool-table.ts";
import { CORE_WARNING, toolsScreen } from "../src/tools-screen.ts";
import { FakeLink, scripted } from "./providers-helpers.ts";

type Tools = Extract<EngineEvent, { ev: "tools" }>;

const SOON = new Set(["schedule", "vision", "speech-to-text", "text-to-speech", "image", "video-generation", "video-analysis", "computer-use"]);
const item = (name: string, core: boolean): ToolInfo => ({ name, title: name, about: "", access: "read", enabled: true, core, small: false, calls: 0, set: "files" });
const BACKENDS: BackendInfo[] = [{ id: "local", label: "This computer", about: "Commands run here.", ready: true, using: true }, { id: "docker", label: "A container", about: "In a clean container.", ready: false, using: false, hint: "Install the container program first." }];

function report(over: Record<string, Partial<ToolEntry>> = {}): Tools {
  const entries = TOOL_ROWS.map((r): ToolEntry => {
    const state: ToolEntry["state"] = SOON.has(r.id) ? "soon" : r.id === "browser" ? "needs-setup" : r.id === "code" ? "experimental" : "on";
    return { id: r.id, category: r.category, names: [...r.names], title: r.title, about: r.about, on: state === "on" || state === "needs-setup", state, calls: 0, ...over[r.id] };
  });
  return { ev: "tools", items: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"].map((n) => item(n, true)), sets: [], entries, categories: [...CATEGORIES], backends: BACKENDS };
}

function hub(start: Tools = report()): FakeLink {
  let now = start;
  return new FakeLink((c) => {
    if (c.cmd === "tool.toggle") now = { ...now, entries: now.entries.map((e) => (e.id === c.name ? { ...e, on: c.enabled as boolean } : e)) };
    if (c.cmd === "terminal.use") now = { ...now, backends: now.backends.map((b) => ({ ...b, using: b.id === c.backend })) };
    return now;
  });
}
const toggles = (l: FakeLink): [string, boolean][] => l.commands("tool.toggle").map((c) => [c.name as string, c.enabled as boolean]);

describe("/tools", () => {
  test("the headings come first, with how many of their tools are on, and where commands run last", async () => {
    const t = scripted([undefined]);
    await toolsScreen(t.kit(hub()));
    const first = t.shown[0]!;
    expect(first.title).toBe("Tools");
    expect(first.items.map((i) => i.label)).toEqual([...CATEGORIES.map((c) => c.title), "Where commands run: This computer"]);
    expect(first.items.map((i) => i.hint)).toEqual([
      "2 of 3 on: Files & Search, Terminal & Processes, Code Execution",
      "2 of 3 on: Web Search, Web Fetch, Browser Automation",
      "3 of 4 on: Questions, Task Planning, Helpers, Schedule",
      "3 of 3 on: Memory, Session Search, Skills",
      "0 of 6 on: Vision, Speech to Text, Text to Speech, Image Generation, Video Generation, Video Analysis",
      "0 of 1 on: Computer Use",
      "Choose this computer, a container, or another computer",
    ]);
  });
  test("a heading lists its tools with on or off, and says what cannot be switched", async () => {
    const t = scripted(["Browse & research", undefined, undefined]);
    await toolsScreen(t.kit(hub()));
    expect(t.shown[1]!.items.map((i) => [i.label, i.hint])).toEqual([
      ["on   Web Search", "Find pages about a question."],
      ["on   Web Fetch", "Read one page and give back its text."],
      ["     Browser Automation  Needs setup", "Drive a real browser: open, click, type, look."],
    ]);
    const u = scripted(["See, hear & create", undefined, undefined]);
    await toolsScreen(u.kit(hub()));
    expect(u.shown[1]!.items.map((i) => i.label)).toContain("     Video Analysis  Soon");
  });
  test("Memory and Session Search are separate switches: one press changes one entry, and the list shows it", async () => {
    const link = hub();
    const t = scripted(["Memory & knowledge", 1, undefined, undefined]);
    await toolsScreen(t.kit(link));
    expect(toggles(link)).toEqual([["session-search", false]]);
    expect(t.shown[2]!.items.map((i) => i.label.slice(0, 3))).toEqual(["on ", "off", "on "]);
  });
  test("files, search and changes are one switch: one press sends one command, after asking", async () => {
    const link = hub();
    const t = scripted(["Work", 0, "Turn it off", undefined, undefined]);
    await toolsScreen(t.kit(link));
    expect(toggles(link)).toEqual([["files", false]]);
    expect(t.shown[2]!.title).toBe("Turn off Files & Search?");
  });
  test("a tool that coding is made of asks before it is switched off, and keeping it on changes nothing", async () => {
    const link = hub();
    const t = scripted(["Work", 1, "Keep it on", undefined, undefined]);
    await toolsScreen(t.kit(link));
    expect(t.shown[2]!.title).toBe("Turn off Terminal & Processes?");
    expect(t.shown[2]!.items.map((i) => [i.label, i.hint])).toEqual([["Keep it on", CORE_WARNING], ["Turn it off", undefined]]);
    expect(link.commands("tool.toggle")).toEqual([]);
  });
  test("switching one on never asks; Code Execution is off and experimental until it is switched on", async () => {
    const link = hub();
    const t = scripted(["Work", 2, undefined, undefined]);
    await toolsScreen(t.kit(link));
    expect(t.shown[1]!.items[2]!.label).toBe("off  Code Execution  Experimental");
    expect(toggles(link)).toEqual([["code", true]]);
    expect(t.shown[2]!.items[2]!.label).toBe("on   Code Execution  Experimental");
  });
  test("a tool that waits for setup, is not built yet or cannot run here has no switch: pressing it toggles nothing", async () => {
    const link = hub(report({ code: { state: "unavailable-here" } }));
    const t = scripted(["Work", 2, undefined, "Browse & research", 2, undefined, "Control the computer", 0, undefined, undefined]);
    await toolsScreen(t.kit(link));
    expect(t.shown[1]!.items[2]!.label).toBe("     Code Execution  Not on this computer");
    expect(link.commands("tool.toggle")).toEqual([]);
  });
  test("a tool that waits for setup starts it only when the hub says it has one", async () => {
    const link = hub(report({ browser: { setup: true } }));
    const said = link.send.bind(link);
    link.send = (cmd) => { said(cmd); if ((cmd as { cmd: string }).cmd === "tool.setup") queueMicrotask(() => link.emit({ ev: "tool.setup", id: "browser", state: "unavailable", error: "No browser was found on this computer." })); };
    const t = scripted(["Browse & research", 2, undefined, undefined]);
    await toolsScreen(t.kit(link));
    expect(link.commands("tool.setup")).toEqual([{ cmd: "tool.setup", id: "browser" }]);
    expect(link.commands("tool.toggle")).toEqual([]);
    expect(t.shown[2]!.frame.notice).toEqual(["No browser was found on this computer."]);
  });
  test("a refusal of the hub is said on the next screen", async () => {
    const link = new FakeLink((c) => (c.cmd === "tool.toggle" ? "That tool is not one of the agent's." : report()));
    const t = scripted(["Memory & knowledge", 0, undefined, undefined]);
    await toolsScreen(t.kit(link));
    expect(t.shown[2]!.frame.notice).toEqual(["That tool is not one of the agent's."]);
  });
  test("where commands run: a place that is ready is chosen, one that is not says what to do", async () => {
    const link = hub();
    const t = scripted([6, 1, 6, 0, undefined]);
    const kit = t.kit(link);
    await toolsScreen(kit);
    expect(t.shown[2]!.frame.notice).toEqual(["Install the container program first."]);
    expect(link.commands("terminal.use")).toEqual([{ cmd: "terminal.use", backend: "local" }]);
  });
  test("the hub refusing the list ends the screen with its sentence", async () => {
    const t = scripted([]);
    await toolsScreen(t.kit(new FakeLink(() => "Not available here.")));
    expect(t.said).toEqual(["Not available here."]);
  });
});
