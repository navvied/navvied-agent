import { afterAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelRequest, Tool } from "../src/types.ts";
import { HOOK_MS, cleanupAll, prompt, rig, until } from "./helpers.ts";

afterAll(cleanupAll, HOOK_MS);

const isMain = (req: ModelRequest): boolean => req.tools.some((t) => t.name === "Agent");
const names = (req: ModelRequest): string[] => req.tools.map((t) => t.name);
const words = "search the web for the latest news and price, then 1. read it\n2. fix it";

describe("the tools offered stay the same for a whole conversation", () => {
  test("requests 1 and 2, the next turn and the turn a helper's message starts offer the same tools, and the prompt is byte for byte the same", async () => {
    const r = rig((req, _n, dir) => {
      if (!isMain(req)) return { text: words };
      const last = req.messages.at(-1);
      if (last?.role === "user" && String(last.content).startsWith("[Helper helper1 finished")) return { text: "done" };
      const tools = req.messages.filter((m) => m.role === "tool").length;
      if (tools === 0) return { calls: [{ name: "Read", args: { file_path: join(dir, "a.txt") } }] };
      if (tools === 1) return { calls: [{ name: "Agent", args: { prompt: "look", background: true } }] };
      return { text: "ok" };
    });
    writeFileSync(join(r.dir, "a.txt"), "x");
    await r.turn(prompt("fix it"));
    await until(() => r.of("notice").some((n) => n.msg.startsWith("A helper finished")));
    await r.engine.idle();
    await until(() => r.provider.requests.some((q) => String(q.messages.at(-1)?.content).startsWith("[Helper helper1 finished")));
    await r.turn(prompt(words));
    const main = r.provider.requests.filter(isMain);
    expect(main.length).toBeGreaterThanOrEqual(5);
    for (const q of main) {
      expect(names(q)).toEqual(names(main[0]!));
      expect(q.system).toBe(main[0]!.system);
    }
    expect(names(main[0]!)).toEqual(expect.arrayContaining(["TodoWrite", "MultiEdit", "apply_patch"]));
    expect(names(main[0]!)).not.toContain("Remember");
    r.cleanup();
  });

  test("a tool is offered to a small model only as it was at the start, and the task list is not offered to it", async () => {
    const r = rig(() => ({ text: "ok" }), { window: 8000, small: true });
    await r.turn(prompt(words));
    expect(names(r.provider.requests[0]!)).not.toContain("TodoWrite");
    r.cleanup();
  });

  test("a program connected later adds its tools after the others, and nothing else moves", async () => {
    const r = rig(() => ({ text: "ok" }));
    await r.turn(prompt("hello"));
    const extra: Tool = { name: "mcp__records__get", readOnly: true, description: "get", parameters: { type: "object", properties: {} }, title: () => "get", run: async () => "x" };
    r.engine.addTools([extra]);
    await r.turn(prompt("again"));
    const [first, second] = r.provider.requests;
    expect(names(second!)).toEqual([...names(first!), "mcp__records__get"]);
    r.cleanup();
  });

  test("a hidden tool called by its name is run, and the list is the same afterwards", async () => {
    const r = rig((req) => (req.messages.some((m) => m.role === "tool") ? { text: "ok" } : { calls: [{ name: "NotebookEdit", args: { notebook_path: "x.ipynb" } }] }), { window: 8000, small: true });
    await r.turn(prompt("hello"));
    const [first, second] = r.provider.requests;
    expect(String(second!.messages.find((m) => m.role === "tool")!.content)).not.toContain("there is no tool");
    expect(names(first!)).not.toContain("NotebookEdit");
    expect(names(second!)).toEqual(names(first!));
    r.cleanup();
  });

  test("a small model asked to search the web on message 3 calls WebSearch by name and it runs, and the tools array is byte for byte the same all along", async () => {
    const r = rig((req) => {
      const last = req.messages.at(-1);
      const asked = req.messages.some((m) => m.role === "user" && String(m.content).includes("search the web"));
      if (asked && last?.role === "user") return { calls: [{ name: "WebSearch", args: { query: "navvied test" } }] };
      return { text: "ok" };
    }, { window: 8000, small: true });
    await r.turn(prompt("hello"));
    await r.turn(prompt("and again"));
    await r.turn(prompt("search the web for navvied"));
    const reqs = r.provider.requests;
    expect(reqs.length).toBeGreaterThanOrEqual(4);
    for (const q of reqs) expect(JSON.stringify(q.tools)).toBe(JSON.stringify(reqs[0]!.tools));
    expect(names(reqs[0]!)).not.toContain("WebSearch");
    expect(r.of("tool").some((t) => t.name === "WebSearch" && t.status !== undefined)).toBe(true);
    const result = reqs.at(-1)!.messages.filter((m) => m.role === "tool").at(-1);
    expect(String(result!.content)).not.toContain("there is no tool");
    expect(String(result!.content)).not.toContain("not available");
    r.cleanup();
  });
});
