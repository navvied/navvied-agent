import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INSTRUCTION_FILE, loadInstructions } from "../src/index.ts";
import { systemPrompt } from "../src/prompt.ts";
import { cleanupAll, prompt, rig } from "./helpers.ts";

const dirs: string[] = [];
const tmp = () => { const d = realpathSync(mkdtempSync(join(tmpdir(), "navvied-instr-"))); dirs.push(d); return d; };
afterAll(() => { cleanupAll(); dirs.forEach((d) => rmSync(d, { recursive: true, force: true })); });
const put = (dir: string, text: string) => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, INSTRUCTION_FILE), text); };

describe("loadInstructions", () => {
  test("nothing there → undefined", () => expect(loadInstructions(tmp())).toBeUndefined());

  test("reads the file in the working directory", () => {
    const d = tmp(); put(d, "Use tabs.\n");
    expect(loadInstructions(d)).toBe(`# Instructions from ${INSTRUCTION_FILE}\nUse tabs.`);
  });

  test("walks up to the project root (the directory with .git), outer files first so inner ones win", () => {
    const root = tmp();
    mkdirSync(join(root, ".git"));
    put(root, "root rule");
    put(join(root, "packages/app"), "app rule");
    const out = loadInstructions(join(root, "packages/app"))!;
    expect(out.indexOf("root rule")).toBeLessThan(out.indexOf("app rule"));
    expect(out).toContain("# Instructions from ../../NAVVIED.md");
  });

  test("does not read above the project root", () => {
    const outer = tmp(), project = join(outer, "project");
    put(outer, "outside the project");
    mkdirSync(join(project, ".git"), { recursive: true });
    put(project, "inside");
    expect(loadInstructions(project)).not.toContain("outside the project");
  });

  test("the user's own file comes first", () => {
    const d = tmp(), user = tmp();
    mkdirSync(join(d, ".git")); put(d, "project rule"); put(user, "personal rule");
    const out = loadInstructions(d, user)!;
    expect(out.startsWith("# Your personal instructions\npersonal rule")).toBe(true);
    expect(out).toContain("project rule");
  });

  test("blank files and directories with that name are ignored", () => {
    const d = tmp(); mkdirSync(join(d, ".git"));
    writeFileSync(join(d, INSTRUCTION_FILE), "  \n");
    expect(loadInstructions(d)).toBeUndefined();
    rmSync(join(d, INSTRUCTION_FILE)); mkdirSync(join(d, INSTRUCTION_FILE));
    expect(loadInstructions(d)).toBeUndefined();
  });

  test("size is capped per file and in total", () => {
    const d = tmp(); mkdirSync(join(d, ".git"));
    put(d, "x".repeat(50_000));
    const one = loadInstructions(d)!;
    expect(one.length).toBeLessThan(20_100);
    for (const n of ["a", "b", "c", "d"]) put(join(d, n), "y".repeat(20_000));
    const deep = loadInstructions(join(d, "d"))!;
    expect(deep.length).toBeLessThan(40_200);
    const three = tmp(), nested = join(three, "1/2/3/4");
    mkdirSync(join(three, ".git"));
    for (const p of ["", "1", "1/2", "1/2/3", "1/2/3/4"]) put(join(three, p), "z".repeat(20_000));
    const capped = loadInstructions(nested)!;
    expect(capped.length).toBeLessThan(60_100);
    expect(capped.endsWith("[instructions truncated]")).toBe(true);
  });
});

describe("in the prompt", () => {
  const info = { cwd: "/w", platform: "linux", date: "2026-01-01" };
  test("included when present, absent otherwise", () => {
    expect(systemPrompt({ ...info, instructions: "Always run the linter." }, "auto")).toContain("Always run the linter.");
    expect(systemPrompt(info, "auto")).not.toContain("standing instructions");
  });
});

describe("in the engine", () => {
  test("re-read at every model call, so an edit applies to the next turn", async () => {
    let text = "first rule";
    const r = rig(() => ({ text: "ok" }), { instructions: () => text });
    await r.turn(prompt("one"));
    text = "second rule";
    await r.turn(prompt("two"));
    expect(r.provider.requests[0]!.system).toContain("first rule");
    expect(r.provider.requests[1]!.system).toContain("second rule");
    expect(r.provider.requests[1]!.system).not.toContain("first rule");
    r.cleanup();
  });
});

describe("other names for the same instructions", () => {
  const names = ["NAVVIED.md", "AGENTS.md", "OTHER.md"];
  const write = (dir: string, name: string, text: string) => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, name), text); };

  test("by default only NAVVIED.md is read", () => {
    const d = tmp(); write(d, "AGENTS.md", "from agents");
    expect(loadInstructions(d)).toBeUndefined();
  });
  test("a later name is read when the first is absent, and says which file it came from", () => {
    const d = tmp(); write(d, "AGENTS.md", "from agents");
    expect(loadInstructions(d, undefined, undefined, names)).toBe("# Instructions from AGENTS.md\nfrom agents");
  });
  test("in one folder only the first name that exists is read, never two", () => {
    const d = tmp(); write(d, "AGENTS.md", "from agents"); write(d, "OTHER.md", "from other"); write(d, "NAVVIED.md", "from navvied");
    const out = loadInstructions(d, undefined, undefined, names)!;
    expect(out).toContain("from navvied");
    expect(out).not.toContain("from agents");
    expect(out).not.toContain("from other");
  });
  test("each folder on the way down may use a different name, outer first", () => {
    const root = tmp(); mkdirSync(join(root, ".git"));
    write(root, "AGENTS.md", "root rule"); write(join(root, "app"), "OTHER.md", "app rule");
    const out = loadInstructions(join(root, "app"), undefined, undefined, names)!;
    expect(out.indexOf("root rule")).toBeLessThan(out.indexOf("app rule"));
    expect(out).toContain("# Instructions from ../AGENTS.md");
    expect(out).toContain("# Instructions from OTHER.md");
  });
  test("an empty file is skipped for the next name", () => {
    const d = tmp(); write(d, "NAVVIED.md", "  \n"); write(d, "AGENTS.md", "real text");
    expect(loadInstructions(d, undefined, undefined, names)).toContain("real text");
  });
  test("the user's own folder only ever offers NAVVIED.md", () => {
    const home = tmp(), project = tmp();
    write(home, "AGENTS.md", "personal agents");
    expect(loadInstructions(project, home, undefined, names)).toBeUndefined();
  });
});
