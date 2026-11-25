import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOOK_MS, cleanupAll, prompt, rig, until, wait } from "./helpers.ts";
import { isolate } from "../src/worktree.ts";
import type { ModelRequest } from "../src/types.ts";

afterAll(cleanupAll, HOOK_MS);

const isMain = (req: ModelRequest): boolean => req.tools.some((t) => t.name === "Agent");
const tools = (req: ModelRequest): string[] => req.messages.filter((m) => m.role === "tool").map((m) => String(m.content));

describe("background helpers", () => {
  test("the call returns at once, and the result comes back as a message when the helper ends", async () => {
    const r = rig((req) => {
      if (!isMain(req)) return { text: "found: it is in src/a.ts line 3", delayMs: 60 };
      if (req.messages.at(-1)?.role === "user" && String(req.messages.at(-1)!.content).startsWith("[Helper helper1 finished")) return { text: "so it is in src/a.ts" };
      return tools(req).length ? { text: "working on the rest meanwhile" } : { calls: [{ name: "Agent", args: { description: "find it", prompt: "where is it?", background: true } }] };
    });
    await r.turn(prompt("find it while I wait"));
    expect(tools(r.provider.requests.at(-1)!)[0]).toStartWith("Helper helper1 started in the background");
    await until(() => r.of("notice").some((n) => n.msg.startsWith("A helper finished")));
    await r.engine.idle();
    await until(() => r.text().includes("so it is in src/a.ts"));
    const message = r.provider.requests.at(-1)!.messages.at(-1)!;
    expect(message.role).toBe("user");
    expect(String(message.content)).toStartWith("[Helper helper1 finished: find it]\n");
    expect(String(message.content)).toContain("it is in src/a.ts line 3");
    r.cleanup();
  });

  test("a result that arrives while the agent is working joins that turn instead of starting another", async () => {
    let helperDone = false;
    const r = rig((req) => {
      if (!isMain(req)) { helperDone = true; return { text: "the answer" }; }
      if (!tools(req).length) return { calls: [{ name: "Agent", args: { prompt: "look", background: true } }] };
      if (!helperDone) return { calls: [{ name: "Glob", args: { pattern: "*" } }], delayMs: 20 };
      return { text: "done" };
    });
    await r.turn(prompt("go"));
    await until(() => r.provider.requests.some((q) => q.messages.some((m) => m.role === "user" && String(m.content).includes("the answer"))));
    expect(r.of("done").length).toBeGreaterThanOrEqual(1);
    r.cleanup();
  });

  test("stopping the job by its id ends the helper", async () => {
    const r = rig((req) => (isMain(req) ? (tools(req).length ? { text: "ok" } : { calls: [{ name: "Agent", args: { prompt: "slow", background: true } }] }) : { text: "late", delayMs: 5000 }));
    await r.turn(prompt("go"));
    r.send({ cmd: "job.stop", id: "helper1" });
    await until(() => r.of("notice").some((n) => n.msg.startsWith("A helper finished")));
    r.cleanup();
  });

  test("only so many helpers work at once: more in the background are refused, more in the foreground wait their turn", async () => {
    const r = rig((req) => (isMain(req)
      ? (tools(req).length ? { text: "ok" } : { calls: [1, 2, 3].map((n) => ({ name: "Agent", args: { prompt: `task ${n}`, background: true } })) })
      : { text: "late", delayMs: 300 }), { helperLimits: { parallel: 2 } });
    await r.turn(prompt("go"));
    const got = tools(r.provider.requests.at(-1)!).sort();
    expect(got.filter((g) => g.startsWith("Helper helper")).length).toBe(2);
    expect(got.find((g) => g.startsWith("Error"))).toContain("2 helpers are already working");
    r.cleanup();
    const fg = rig((req) => (isMain(req) ? (tools(req).length ? { text: "ok" } : { calls: [1, 2, 3, 4].map((n) => ({ name: "Agent", args: { prompt: `task ${n}` } })) }) : { text: "x", delayMs: 150 }), { helperLimits: { parallel: 2 } });
    fg.send(prompt("go"));
    await wait(80);
    expect(fg.provider.requests.filter((q) => !isMain(q))).toHaveLength(2);
    await fg.engine.idle();
    expect(fg.provider.requests.filter((q) => !isMain(q))).toHaveLength(4);
    fg.cleanup();
  });
});

describe("a helper's limits", () => {
  test("one that runs past its time is stopped and the answer says so", async () => {
    const r = rig((req) => (isMain(req) ? (tools(req).length ? { text: "ok" } : { calls: [{ name: "Agent", args: { prompt: "slow" } }] }) : { text: "partial", delayMs: 5000 }), { helperLimits: { seconds: 0.05 } });
    await r.turn(prompt("go"));
    expect(tools(r.provider.requests.at(-1)!)[0]).toContain("[the helper ran out of time (0.05 seconds)]");
    r.cleanup();
  });

  test("one that takes more steps than it may is stopped, and the answer says so", async () => {
    const r = rig((req) => (isMain(req) ? (tools(req).length ? { text: "ok" } : { calls: [{ name: "Agent", args: { prompt: "loop" } }] }) : { calls: [{ name: "Glob", args: { pattern: "*" } }] }), { helperLimits: { steps: 2 } });
    await r.turn(prompt("go"));
    expect(tools(r.provider.requests.at(-1)!)[0]).toContain("[the helper had a problem: Stopped after 2 steps");
    r.cleanup();
  });

  test("it is told how to answer: what it found, with paths", async () => {
    const seen: string[] = [];
    const r = rig((req) => { if (isMain(req)) return tools(req).length ? { text: "ok" } : { calls: [{ name: "Agent", args: { prompt: "look" } }] }; seen.push(req.system); return { text: "x" }; });
    await r.turn(prompt("go"));
    expect(seen[0]).toContain("Answer with what you found, with file paths and line numbers.");
    r.cleanup();
  });
});

const writer = { name: "writer", description: "writes files", tools: ["Write", "Bash"], prompt: "You write files." };

describe("helpers that need the person", () => {
  const asksToReset = (req: ModelRequest) => (isMain(req)
    ? (tools(req).length ? { text: `end: ${tools(req)[0]}` } : { calls: [{ name: "Agent", args: { prompt: "reset", agent: "writer" } }] })
    : (tools(req).length ? { text: `helper saw: ${tools(req)[0]}` } : { calls: [{ name: "Bash", args: { command: "git reset --hard" } }] }));

  test("it asks the person through the engine that started it, naming the helper's step", async () => {
    const r = rig(asksToReset, { agents: [writer] });
    r.send(prompt("go", { mode: "auto" }));
    await until(() => r.of("approval").length === 1);
    const a = r.of("approval")[0]!;
    expect(a.title).toStartWith("A helper asks:");
    const agentCall = r.of("tool").find((e) => e.name === "Agent")!.id;
    expect(a.tool).toStartWith(`${agentCall}.`);
    r.send({ cmd: "approve", id: a.id, optionId: "deny" });
    await r.engine.idle();
    expect(tools(r.provider.requests.at(-1)!)[0]).toContain("helper saw: The user denied this action.");
    r.cleanup();
  });

  test("with nobody to ask it is blocked, with the reason", async () => {
    const r = rig(asksToReset, { agents: [writer], noQuestions: true });
    await r.turn(prompt("go", { mode: "auto" }));
    expect(r.of("approval")).toHaveLength(0);
    expect(tools(r.provider.requests.at(-1)!)[0]).toContain("Blocked: this needs the person's say-so");
    r.cleanup();
  });

  test("a helper that changes files cannot run in the background in the same folder", async () => {
    const r = rig((req) => (isMain(req) ? (tools(req).length ? { text: "ok" } : { calls: [{ name: "Agent", args: { prompt: "x", agent: "writer", background: true } }] }) : { text: "x" }), { agents: [writer] });
    await r.turn(prompt("go", { mode: "auto" }));
    expect(tools(r.provider.requests.at(-1)!)[0]).toContain("works in the foreground");
    r.cleanup();
  });
});

describe("a helper in a copy of the project", () => {
  const repo = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "navvied-iso-"));
    const git = (...a: string[]): void => { execFileSync("git", a, { cwd: dir, stdio: "ignore" }); };
    git("init", "-q"); git("config", "user.email", "t@example.com"); git("config", "user.name", "t");
    writeFileSync(join(dir, "a.txt"), "one\n"); git("add", "."); git("commit", "-qm", "first");
    return dir;
  };
  const isolated = { ...writer, tools: ["Write"], isolation: "worktree" as const };

  test("a project reached through a link (macOS temporary folders, Windows short names) still gets its copy in the same place", async () => {
    const dir = repo();
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "s.txt"), "x\n");
    execFileSync("git", ["add", "."], { cwd: dir }); execFileSync("git", ["commit", "-qm", "sub"], { cwd: dir });
    const link = join(mkdtempSync(join(tmpdir(), "navvied-link-")), "project");
    symlinkSync(dir, link, "dir");
    const copy = await isolate(join(link, "sub"));
    if ("error" in copy) throw new Error(copy.error);
    expect(copy.dir.endsWith("sub")).toBe(true);
    // The copy is a worktree (its top folder has a .git file); the project itself has a .git folder.
    expect(statSync(join(copy.dir, "..", ".git")).isFile()).toBe(true);
    expect(existsSync(join(copy.dir, "s.txt"))).toBe(true);
    await copy.finish();
  });

  test("its changes land in the copy, which is kept and named; the project is untouched", async () => {
    const dir = repo();
    const r = rig((req) => (isMain(req)
      ? (tools(req).length ? { text: "ok" } : { calls: [{ name: "Agent", args: { prompt: "write", agent: "writer" } }] })
      : (tools(req).length ? { text: "wrote it" } : { calls: [{ name: "Write", args: { file_path: "made.txt", content: "hello\n" } }] })), { agents: [isolated], cwd: dir });
    await r.turn(prompt("go", { mode: "auto" }));
    const out = tools(r.provider.requests.at(-1)!)[0]!;
    const where = /worked in a copy of the project at (\S+)/.exec(out)?.[1];
    expect(where).toBeDefined();
    expect(readFileSync(join(where!, "made.txt"), "utf8")).toBe("hello\n");
    expect(existsSync(join(dir, "made.txt"))).toBe(false);
    execFileSync("git", ["worktree", "remove", "--force", where!], { cwd: dir });
    r.cleanup();
  });

  test("a copy nothing changed in is removed, and nothing is left in the project's list of worktrees", async () => {
    const dir = repo();
    const r = rig((req) => (isMain(req) ? (tools(req).length ? { text: "ok" } : { calls: [{ name: "Agent", args: { prompt: "look", agent: "writer" } }] }) : { text: "nothing to change" }), { agents: [isolated], cwd: dir });
    await r.turn(prompt("go", { mode: "auto" }));
    expect(tools(r.provider.requests.at(-1)!)[0]).toBe("nothing to change");
    expect(execFileSync("git", ["worktree", "list"], { cwd: dir }).toString().trim().split("\n")).toHaveLength(1);
    r.cleanup();
  });

  test("a folder that is not a git project is told, and the helper does not start", async () => {
    const r = rig((req) => (isMain(req) ? (tools(req).length ? { text: "ok" } : { calls: [{ name: "Agent", args: { prompt: "x", agent: "writer" } }] }) : { text: "should not run" }), { agents: [isolated] });
    await r.turn(prompt("go", { mode: "auto" }));
    expect(tools(r.provider.requests.at(-1)!)[0]).toStartWith("Error: this folder is not a git project");
    expect(r.provider.requests.filter((q) => !isMain(q))).toHaveLength(0);
    r.cleanup();
  });
});
