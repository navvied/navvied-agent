import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Jobs, defaultTools, loadSkills, parseFrontmatter, readSkill, skillsPrompt, type SkillInfo } from "../src/index.ts";
import { toolsFor } from "../src/permissions.ts";
import type { Tool, ToolContext } from "../src/types.ts";
import { cleanupAll, prompt, rig } from "./helpers.ts";
import { stopAllJobs } from "../src/index.ts";
import { HOOK_MS, hook, removeTrees } from "../../protocol/test/support/cleanup.ts";

const dirs: string[] = [];
const temp = (): string => { const d = mkdtempSync(join(tmpdir(), "navvied-skills-")); dirs.push(d); return d; };
const jobs = new Jobs(() => {});
afterAll(hook("skills removes what it made", async () => { await stopAllJobs(); await removeTrees(dirs); jobs.close(); await cleanupAll(); }), HOOK_MS);

function skill(root: string, folder: string, text: string, extra: Record<string, string> = {}): void {
  mkdirSync(join(root, folder), { recursive: true });
  writeFileSync(join(root, folder, "SKILL.md"), text);
  for (const [name, body] of Object.entries(extra)) writeFileSync(join(root, folder, name), body);
}
const tool = defaultTools().find((t) => t.name === "Skill") as Tool;
const ctx = (skills: SkillInfo[]): ToolContext => ({ cwd: "/", signal: new AbortController().signal, emit: () => {}, allowPrivateNetwork: false, jobs, skills: () => skills });

describe("reading a skill file", () => {
  test("the block between the --- lines gives name and description; quotes come off; the rest is the text", () => {
    expect(parseFrontmatter('---\nname: changelog\ndescription: "Write a changelog"\nlicense: MIT\n---\nStep one.\nStep two.\n')).toEqual({
      meta: { name: "changelog", description: "Write a changelog", license: "MIT" }, body: "Step one.\nStep two.\n",
    });
    expect(parseFrontmatter("no block here")).toEqual({ meta: {}, body: "no block here" });
    expect(parseFrontmatter("---\nunclosed\n").meta).toEqual({});
  });
});

describe("finding skills", () => {
  test("a folder with a SKILL.md is a skill; the folder name is the name when the file gives none; bad names and loose files are skipped", () => {
    const root = temp();
    skill(root, "release", "---\ndescription: Cut a release\n---\nDo it.");
    skill(root, "review", "---\nname: code-review\ndescription: Review a change\n---\nLook.");
    skill(root, "Bad Name!", "---\ndescription: nope\n---\nx");
    mkdirSync(join(root, "empty"));
    writeFileSync(join(root, "loose.md"), "x");
    expect(loadSkills({ user: root }).map((s) => [s.name, s.description, s.source])).toEqual([["release", "Cut a release", "user"], ["code-review", "Review a change", "user"]]);
  });
  test("a project skill replaces the person's own with the same name, and a missing folder is nothing", () => {
    const user = temp(), project = temp();
    skill(user, "deploy", "---\ndescription: mine\n---\nmine");
    skill(user, "other", "---\ndescription: other\n---\nx");
    skill(project, "deploy", "---\ndescription: the project's\n---\nproject");
    const all = loadSkills({ user, project: [project, "/no/such/folder"] });
    expect(all.find((s) => s.name === "deploy")).toMatchObject({ description: "the project's", source: "project" });
    expect(all.map((s) => s.name).sort()).toEqual(["deploy", "other"]);
    expect(loadSkills({})).toEqual([]);
  });
  test("reading gives the instructions without the block, shortened when huge, and names the other files in the folder", () => {
    const root = temp();
    skill(root, "big", `---\ndescription: d\n---\n${"x".repeat(40_000)}`, { "template.md": "t", "notes.txt": "n" });
    const [s] = loadSkills({ user: root });
    const text = readSkill(s!);
    expect(text.startsWith("# Skill: big\n\nxxx")).toBe(true);
    expect(text).toContain("… [shortened]");
    expect(text).toContain("Files next to this skill");
    expect(text).toContain("template.md");
    expect(text).not.toContain("description: d");
  });
});

describe("what the model is told about skills", () => {
  const list = (n: number): SkillInfo[] => Array.from({ length: n }, (_, i) => ({ name: `s${i}`, description: "d".repeat(150), dir: "/x", source: "user" as const }));
  test("nothing when there are none; names with descriptions otherwise; fewer and shorter for a small model", () => {
    expect(skillsPrompt([], false)).toBeUndefined();
    const full = skillsPrompt(list(50), false)!;
    expect(full).toContain("- s0: " + "d".repeat(150));
    expect(full).toContain("(and 10 more)");
    const small = skillsPrompt(list(10), true)!;
    expect(small.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(6);
    expect(small).toContain("(and 4 more)");
    expect(small).toContain("- s0: " + "d".repeat(100) + "\n");
  });
});

describe("the Skill tool", () => {
  test("is read-only, and offered only while there are skills", () => {
    expect(tool.readOnly).toBe(true);
    const all = defaultTools();
    const names = (skills: number, mode: "auto" | "plan") => toolsFor(mode, all, { small: false, userText: "", jobs: 0, skills }).map((t) => t.name);
    expect(names(0, "auto")).not.toContain("Skill");
    expect(names(2, "auto")).toContain("Skill");
    expect(names(2, "plan")).toContain("Skill");
  });
  test("loads the named skill, and an unknown name lists the real ones", async () => {
    const root = temp();
    skill(root, "release", "---\ndescription: Cut a release\n---\nTag it, then push.");
    const skills = loadSkills({ user: root });
    expect(await tool.run({ name: "release" }, ctx(skills))).toContain("Tag it, then push.");
    expect(await tool.run({ name: "nope" }, ctx(skills))).toBe('Error: there is no skill "nope". Skills: release.');
    expect(await tool.run({ name: "x" }, ctx([]))).toBe('Error: there is no skill "x".');
  });
});

describe("the engine with skills", () => {
  test("the model sees the list, loads one, and a skill added later is seen on the next turn", async () => {
    const root = temp();
    skill(root, "release", "---\ndescription: Cut a release\n---\nTag it, then push.");
    const r = rig((req) => {
      if (req.messages.at(-1)?.role === "tool") return { text: `read: ${String(req.messages.at(-1)!.content).slice(0, 40)}` };
      return /release/.test(JSON.stringify(req.messages)) ? { calls: [{ name: "Skill", args: { name: "release" } }] } : { text: "nothing to do" };
    }, { skills: () => loadSkills({ user: root }) });
    await r.turn(prompt("cut a release"));
    expect(r.provider.requests[0]!.system).toContain("Skills you can load with the Skill tool");
    expect(r.provider.requests[0]!.system).toContain("- release: Cut a release");
    expect(r.provider.requests[0]!.tools.map((t) => t.name)).toContain("Skill");
    expect(r.text()).toContain("read: # Skill: release");
    skill(root, "tidy", "---\ndescription: Tidy up\n---\nSweep.");
    await r.turn(prompt("anything"));
    expect(r.provider.requests.at(-1)!.system).toContain("- tidy: Tidy up");
    r.cleanup();
  });
  test("without skills the prompt and the tools are as before", async () => {
    const r = rig(() => ({ text: "ok" }));
    await r.turn(prompt("hi"));
    expect(r.provider.requests[0]!.system).not.toContain("Skills you can load");
    expect(r.provider.requests[0]!.tools.map((t) => t.name)).not.toContain("Skill");
    r.cleanup();
  });
});
