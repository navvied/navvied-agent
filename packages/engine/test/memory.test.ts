import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MEMORY_FILE, loadInstructions, memoryText, readNotes, remember } from "../src/index.ts";
import { cleanupAll, prompt, rig } from "./helpers.ts";
import { stopAllJobs } from "../src/index.ts";
import { hook, removeTrees } from "../../protocol/test/support/cleanup.ts";

const dirs: string[] = [];
const temp = (): string => { const d = mkdtempSync(join(tmpdir(), "navvied-memory-")); dirs.push(d); return d; };
afterAll(hook("memory removes what it made", async () => { await stopAllJobs(); await removeTrees(dirs); await cleanupAll(); }));

const paths = () => { const root = temp(); return { user: join(root, "config", MEMORY_FILE), project: join(root, "project", ".navvied", MEMORY_FILE) }; };

describe("keeping notes", () => {
  test("a note is added as one dated line to a file the person can read, with a heading the first time", () => {
    const p = paths();
    expect(remember(p, "project", "  Use tabs,\n not spaces  ", "2026-11-16")).toBe("Remembered for this project: Use tabs, not spaces");
    expect(remember(p, "project", "Tests live in test/", "2026-11-17")).toContain("Remembered for this project");
    expect(readFileSync(p.project, "utf8")).toBe("# What navvied remembers\n\n- 2026-11-16: Use tabs, not spaces\n- 2026-11-17: Tests live in test/\n");
    expect(remember(p, "user", "Answer in Indonesian", "2026-11-16")).toBe("Remembered for every project: Answer in Indonesian");
    expect(existsSync(p.user!)).toBe(true);
  });
  test("an empty note, a very long one, a repeat, a missing place and a full file are each refused in words", () => {
    const p = paths();
    expect(remember(p, "project", "   ", "d")).toBe("Error: the note is empty.");
    expect(remember(p, "project", "x".repeat(501), "d")).toContain("at most 500 characters");
    remember(p, "project", "Same thing", "2026-11-16");
    expect(remember(p, "project", "Same thing", "2026-11-18")).toBe("That is already remembered.");
    expect(readNotes(p.project).split("Same thing").length).toBe(2);
    expect(remember({ project: p.project }, "user", "x", "d")).toContain("no place for notes for every project");
    writeFileSync(p.project, "x".repeat(20_500));
    expect(remember(p, "project", "one more", "d")).toContain("memory file is full");
  });
  test("a folder that cannot be written is an error line, not a crash", () => {
    const root = temp();
    writeFileSync(join(root, "blocker"), "a file where a folder is needed");
    expect(remember({ project: join(root, "blocker", "deeper", "memory.md") }, "project", "x", "d")).toMatch(/^Error: could not write the note/);
  });
});

describe("what is put in front of the model", () => {
  test("both files, headed, without their own heading; nothing when there are none", () => {
    const p = paths();
    expect(memoryText(p)).toBeUndefined();
    remember(p, "user", "Answer in Indonesian", "2026-11-16");
    remember(p, "project", "Use tabs", "2026-11-16");
    const text = memoryText(p)!;
    expect(text).toContain("# Notes you kept for every project\n- 2026-11-16: Answer in Indonesian");
    expect(text).toContain("# Notes you kept for this project\n- 2026-11-16: Use tabs");
    expect(text).not.toContain("What navvied remembers");
  });
  test("it joins the instructions, after them", () => {
    const root = temp();
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, "NAVVIED.md"), "Be brief.");
    const p = paths();
    remember(p, "project", "Use tabs", "2026-11-16");
    const all = loadInstructions(root, undefined, memoryText(p))!;
    expect(all.indexOf("Be brief.")).toBeLessThan(all.indexOf("Use tabs"));
    expect(loadInstructions(temp(), undefined, memoryText(p))).toContain("Use tabs");
  });
});

describe("the Remember tool", () => {
  test("is offered, to any model, only when the person asks to remember something", async () => {
    const big = rig(() => ({ text: "x" }));
    await big.turn(prompt("hi"));
    expect(big.provider.requests[0]!.tools.map((t) => t.name)).not.toContain("Remember");
    await big.turn(prompt("remember that I prefer tabs"));
    expect(big.provider.requests[1]!.tools.map((t) => t.name)).toContain("Remember");
    const small = rig(() => ({ text: "x" }), { window: 8_000 });
    await small.turn(prompt("fix the bug"));
    expect(small.provider.requests[0]!.tools.map((t) => t.name)).not.toContain("Remember");
    await small.turn(prompt("from now on, answer in short sentences"));
    expect(small.provider.requests[1]!.tools.map((t) => t.name)).toContain("Remember");
    big.cleanup(); small.cleanup();
  });
  test("keeps a note when the model asks, and needs approval in Ask mode because it writes", async () => {
    const p = paths();
    const r = rig((req) => (req.messages.at(-1)?.role === "tool" ? { text: "noted" } : { calls: [{ name: "Remember", args: { note: "The staging server is called alpha" } }] }), { memory: p });
    r.send(prompt("remember that", { mode: "ask" }));
    await new Promise((res) => setTimeout(res, 100));
    const card = r.of("approval")[0]!;
    expect(card.title).toBe("Remember: The staging server is called alpha");
    expect(existsSync(p.project)).toBe(false);
    r.send({ cmd: "approve", id: card.id, optionId: "allow" });
    await r.engine.idle();
    expect(readNotes(p.project)).toContain("The staging server is called alpha");
    expect(r.of("tool").find((e) => e.name === "Remember" && e.status === "done")!.output).toContain("Remembered for this project");
    r.cleanup();
  });
  test("without a place to keep notes it says so", async () => {
    const r = rig((req) => (req.messages.at(-1)?.role === "tool" ? { text: "ok" } : { calls: [{ name: "Remember", args: { note: "x" } }] }));
    await r.turn(prompt("remember x"));
    expect(r.of("tool").find((e) => e.name === "Remember" && e.status === "error")!.output).toBe("Error: memory is not available here.");
    r.cleanup();
  });
});
