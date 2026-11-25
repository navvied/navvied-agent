import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentDirs, loadAgents, parseAgent } from "../src/index.ts";
import { cleanupAll, prompt, rig } from "./helpers.ts";
import { stopAllJobs } from "../src/index.ts";
import { HOOK_MS, hook, removeTree } from "../../protocol/test/support/cleanup.ts";

const dir = mkdtempSync(join(tmpdir(), "navvied-agents-"));
afterAll(hook("agents removes what it made", async () => { await stopAllJobs(); await removeTree(dir); await cleanupAll(); }), HOOK_MS);

const reviewer = "---\nname: reviewer\ndescription: Reviews a change for bugs\ntools: Read, Grep\n---\nYou review code. Be strict.\n";

describe("helpers the person defined", () => {
  test("a Markdown file with a description and its instructions is a helper; the tools are a list", () => {
    expect(parseAgent(reviewer, "reviewer.md")).toEqual({ name: "reviewer", description: "Reviews a change for bugs", tools: ["Read", "Grep"], prompt: "You review code. Be strict." });
    expect(parseAgent("---\ndescription: x\n---\nDo x.", "Do-X.md")).toEqual({ name: "do-x", description: "x", prompt: "Do x." });
  });
  test("a file without a description, instructions or a simple name is not a helper", () => {
    expect(parseAgent("---\nname: a\n---\nbody", "a.md")).toBeUndefined();
    expect(parseAgent("---\ndescription: d\n---\n", "a.md")).toBeUndefined();
    expect(parseAgent("---\nname: Bad Name!\ndescription: d\n---\nbody", "x.md")).toBeUndefined();
    expect(parseAgent("no front matter", "a.md")).toBeUndefined();
  });
  test("later folders win over earlier ones with the same name, and a missing folder is fine", () => {
    const own = join(dir, "own"), project = join(dir, "project");
    mkdirSync(own); mkdirSync(project);
    writeFileSync(join(own, "reviewer.md"), reviewer);
    writeFileSync(join(own, "other.md"), "---\ndescription: other\n---\nOther.");
    writeFileSync(join(project, "reviewer.md"), reviewer.replace("Be strict.", "Be kind."));
    const found = loadAgents([own, join(dir, "nowhere"), project]);
    expect(found.map((a) => a.name).sort()).toEqual(["other", "reviewer"]);
    expect(found.find((a) => a.name === "reviewer")!.prompt).toContain("Be kind.");
  });
});

describe("in the engine", () => {
  const defs = [{ name: "reviewer", description: "Reviews a change for bugs", tools: ["Read", "Grep"], prompt: "You review code. Be strict." }];
  const asks = (...agents: { agent?: string; prompt: string }[]) => (req: { messages: { role: string }[]; system?: string }, n: number) =>
    req.system?.includes('the helper "reviewer"') ? { text: "review done" } : n === 0 && req.messages.length === 1 ? { calls: agents.map((a) => ({ name: "Agent", args: { description: "x", ...a } })) } : { text: "all done" };

  test("the agent sees what each helper is for, and a named one works with its own instructions", async () => {
    const r = rig(asks({ agent: "reviewer", prompt: "check a.ts" }), { agents: defs });
    await r.turn(prompt("research and review it", { mode: "auto" }));
    const first = r.provider.requests[0]!;
    expect(JSON.stringify(first.tools)).toContain("reviewer: Reviews a change for bugs");
    const helperCall = r.provider.requests.find((q) => q.system.includes('the helper "reviewer"'))!;
    expect(helperCall.system).toContain("You review code. Be strict.");
    expect(helperCall.tools.map((t) => t.name).sort()).toEqual(["Grep", "Read"]);
    r.cleanup();
  });
  test("an unknown helper is refused in plain words", async () => {
    const r = rig(asks({ agent: "nobody", prompt: "x" }), { agents: defs });
    await r.turn(prompt("go and research it", { mode: "auto" }));
    expect(r.events.some((e) => e.ev === "tool" && e.status === "error" && /no helper "nobody"/.test(e.output ?? ""))).toBe(true);
    r.cleanup();
  });
  test("two helpers asked for in one step work at the same time", async () => {
    const r = rig((req, n) => {
      if (req.system.includes("helper")) return { text: "found", delayMs: 300 };
      return n === 0 && req.messages.length === 1 ? { calls: [{ name: "Agent", args: { prompt: "one" } }, { name: "Agent", args: { prompt: "two" } }] } : { text: "both back" };
    }, { agents: defs });
    const t0 = Date.now();
    r.engine.handle(prompt("research twice", { mode: "auto" }));
    await r.engine.idle();
    expect(Date.now() - t0).toBeLessThan(560); // one after the other would take at least 600
    expect(r.of("text").map((e) => e.text).join("")).toContain("both back");
    r.cleanup();
  });
});

describe("where helpers are read from", () => {
  test("the folders of Claude Code's format are read as well, and navvied's own win over them in the same place", () => {
    expect(agentDirs("/h", "/c", ["/p", "/p/sub"])).toEqual(["/h/.claude/agents", "/c/agents", "/p/.claude/agents", "/p/.navvied/agents", "/p/sub/.claude/agents", "/p/sub/.navvied/agents"]);
    const root = join(dir, "where");
    const claude = join(root, ".claude", "agents"), own = join(root, ".navvied", "agents");
    mkdirSync(claude, { recursive: true }); mkdirSync(own, { recursive: true });
    writeFileSync(join(claude, "a.md"), "---\ndescription: from claude\n---\nA.");
    writeFileSync(join(claude, "b.md"), "---\ndescription: only claude\n---\nB.");
    writeFileSync(join(own, "a.md"), "---\ndescription: from navvied\n---\nA.");
    const found = loadAgents(agentDirs(join(root, "nohome"), join(root, "noconfig"), [root]));
    expect(found.map((d) => `${d.name}:${d.description}`).sort()).toEqual(["a:from navvied", "b:only claude"]);
  });
  test("a helper may ask to work in a copy of the project", () => {
    expect(parseAgent("---\ndescription: d\ntools: Write\nisolation: worktree\n---\nDo.", "w.md")).toMatchObject({ isolation: "worktree" });
    expect(parseAgent("---\ndescription: d\nisolation: other\n---\nDo.", "w.md")).not.toHaveProperty("isolation");
  });
});
