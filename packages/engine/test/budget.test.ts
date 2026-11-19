import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Jobs, defaultTools } from "../src/index.ts";
import { outputBudget, withinBudget } from "../src/tools/util.ts";
import type { ToolContext } from "../src/types.ts";
import { cleanupAll, prompt, rig } from "./helpers.ts";

const dir = mkdtempSync(join(tmpdir(), "navvied-budget-"));
afterAll(() => { rmSync(dir, { recursive: true, force: true }); cleanupAll(); });
const tool = (name: string) => defaultTools().find((t) => t.name === name)!;
const ctx = (): ToolContext => ({ cwd: dir, signal: new AbortController().signal, emit: () => undefined, allowPrivateNetwork: false, jobs: new Jobs(() => undefined) });
const log = Array.from({ length: 3000 }, (_, i) => `2026-11-19T10:00:00Z INFO req-${(i * 7919).toString(16).padStart(12, "0")} /api/items 500 ${i}ms`).join("\n");

describe("how much one result may bring", () => {
  test("it follows the window: little for a small one, more for a large one, never more than 30,000 characters", () => {
    expect(outputBudget(8_000)).toBe(6_000);
    expect(outputBudget(64_000)).toBe(7_680);
    expect(outputBudget(200_000)).toBe(24_000);
    expect(outputBudget(1_000_000)).toBe(30_000);
    expect(outputBudget(undefined)).toBe(24_000);
  });
  test("a result over it is cut in the middle, with a sentence on how to ask for less; one within it is left alone", () => {
    const text = "x".repeat(100_000);
    for (const window of [8_000, 64_000, 1_000_000]) {
      const out = withinBudget("Grep", text, window);
      expect(out.length, String(window)).toBeLessThan(outputBudget(window) + 300);
      expect(out).toContain("characters omitted");
      expect(out).toContain("ask for less");
    }
    expect(withinBudget("Grep", "short", 8_000)).toBe("short");
    const near = "y".repeat(Math.ceil(outputBudget(64_000) * 1.25));
    expect(withinBudget("Bash", near, 64_000)).toBe(near);
  });
  test("a file is read from its start, so most of what is kept is the start", () => {
    const text = `${"S".repeat(50_000)}${"E".repeat(50_000)}`;
    const out = withinBudget("Read", text, 64_000);
    expect(out.indexOf("E")).toBeGreaterThan(out.indexOf("characters omitted"));
    expect((out.match(/S/g) ?? []).length).toBeGreaterThan((out.match(/E/g) ?? []).length * 2);
  });
});

describe("a list of matches or files is short", () => {
  test("Grep shows 100 matches and says how many there were, with the way to narrow", async () => {
    mkdirSync(join(dir, "logs"), { recursive: true });
    writeFileSync(join(dir, "logs/app.log"), log);
    const out = await tool("Grep").run({ pattern: " 500 ", path: "logs" }, ctx());
    expect(out.split("\n").length).toBe(101);
    expect(out).toMatch(/\[(\d+) matches, 100 shown: add a glob or a narrower pattern\]$/);
  });
  test("the search done in the program itself has the same limit (a computer with neither ripgrep nor grep)", async () => {
    const path = process.env.PATH;
    process.env.PATH = "";
    try {
      const out = await tool("Grep").run({ pattern: " 500 ", path: "logs" }, ctx());
      // This search also takes at most 50 matches of a file, which is below the limit of 100 for a list.
      expect(out.split("\n").length).toBeLessThanOrEqual(101);
      expect(out.split("\n").length).toBeGreaterThan(0);
    } finally { process.env.PATH = path; }
  });
  test("a very long line of a match is cut", async () => {
    writeFileSync(join(dir, "wide.txt"), `needle ${"w".repeat(5000)}\n`);
    const out = await tool("Grep").run({ pattern: "needle", path: "wide.txt" }, ctx());
    expect(out.length).toBeLessThan(420);
  });
  test("Glob lists 100 files, the most recent first, and says how many there were", async () => {
    mkdirSync(join(dir, "many"), { recursive: true });
    for (let i = 0; i < 250; i++) writeFileSync(join(dir, "many", `f${i}.txt`), "x");
    const out = await tool("Glob").run({ pattern: "many/*.txt" }, ctx());
    expect(out.split("\n").length).toBe(101);
    expect(out).toMatch(/\[250 files, 100 shown: add a folder to the pattern or a narrower one\]$/);
  });
});

describe("through the engine, whatever the tool", () => {
  const sizes = async (window: number, call: { name: string; args: object }, make: (dir: string) => void): Promise<string> => {
    const r = rig((req) => (req.messages.at(-1)?.role === "tool" ? { text: "done" } : { calls: [call] }), { window });
    make(r.dir);
    await r.turn(prompt("look at it", { mode: "auto" }));
    const out = r.of("tool").find((e) => e.status === "done")?.output ?? "";
    r.cleanup();
    return out;
  };
  test("a big file below the limit that Read refuses cannot pass the window's budget, at any window", async () => {
    const big = Array.from({ length: 40_000 }, (_, i) => `line ${i} ${"data".repeat(25)}`).join("\n");
    for (const window of [8_000, 64_000, 1_000_000]) {
      const out = await sizes(window, { name: "Read", args: { file_path: "big.txt", limit: 5000 } }, (d) => writeFileSync(join(d, "big.txt"), big));
      expect(out.length, String(window)).toBeLessThan(outputBudget(window) + 400);
      expect(out, String(window)).toContain("characters omitted");
      // Under a window whose budget is below what Read keeps by itself, the guard says how to ask for less.
      if (window < 200_000) expect(out, String(window)).toContain("ask for less");
    }
  });
  test("the search that stalled the model: 437 lines of a log, at a window of 64,000", async () => {
    const out = await sizes(64_000, { name: "Grep", args: { pattern: "500", path: "app.log" } }, (d) => writeFileSync(join(d, "app.log"), log));
    expect(out.length).toBeLessThan(outputBudget(64_000) + 400);
    expect(out).toContain("100 shown");
  });
});
