import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySolution, check, loadTask, loadTasks, prepare, protectedHashes, repoFiles, runTask, solutionFiles, summarize, type Task, type TaskResult } from "../src/index.ts";

const TASKS = join(import.meta.dir, "../tasks");
const CLI = join(import.meta.dir, "../../cli/src/main.ts");
const state = mkdtempSync(join(tmpdir(), "navvied-eval-state-"));
afterAll(() => rmSync(state, { recursive: true, force: true }));

describe("the task set", () => {
  const tasks = loadTasks(TASKS);

  test("has unique ids and a prompt, a check, protected tests, and both a start and a solution for each task", () => {
    expect(tasks.length).toBeGreaterThanOrEqual(8);
    expect(new Set(tasks.map((t) => t.id)).size).toBe(tasks.length);
    for (const t of tasks) {
      expect(t.prompt.length).toBeGreaterThan(20);
      expect(t.check).toBe("bun test");
      expect(t.protect).toEqual(["tests/**"]);
      expect(Object.keys(repoFiles(t)).some((f) => f.startsWith("tests/"))).toBe(true);
      expect(Object.keys(solutionFiles(t)).length).toBeGreaterThan(0);
    }
  });

  test.each(tasks.map((t) => [t.id, t] as const))("%s: fails untouched, passes with its reference solution, and the solution leaves the tests alone", async (_id, task) => {
    const dir = prepare(task);
    try {
      const hashes = protectedHashes(dir, task.protect);
      expect((await check(dir, task)).ok).toBe(false);
      applySolution(dir, task);
      expect((await check(dir, task)).ok).toBe(true);
      expect(protectedHashes(dir, task.protect)).toEqual(hashes);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 30_000);

  test("a task filter selects, and an unknown id is an error", () => {
    expect(loadTasks(TASKS, ["deep-merge"]).map((t) => t.id)).toEqual(["deep-merge"]);
    expect(() => loadTasks(TASKS, ["nope"])).toThrow(/unknown task: nope/);
  });

  test("a task without its pieces is rejected", () => {
    const d = mkdtempSync(join(tmpdir(), "navvied-badtask-"));
    writeFileSync(join(d, "task.json"), JSON.stringify({ id: "x", title: "t", prompt: "p", check: "true" }));
    expect(() => loadTask(d)).toThrow(/repo\/ and solution\/ are required/);
    writeFileSync(join(d, "task.json"), JSON.stringify({ id: "x" }));
    expect(() => loadTask(d)).toThrow(/are required/);
    rmSync(d, { recursive: true, force: true });
  });
});

describe("workspace", () => {
  const task = loadTasks(TASKS, ["fix-off-by-one"])[0]!;
  test("starts as a git repository with one commit and the task's files", () => {
    const dir = prepare(task);
    const log = Bun.spawnSync(["git", "log", "--oneline"], { cwd: dir }).stdout.toString().trim().split("\n");
    expect(log).toHaveLength(1);
    expect(existsSync(join(dir, "src/range.ts"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
  test("protected hashes notice an edit, a deletion, and a new file under a protected pattern", () => {
    const dir = prepare(task);
    const base = protectedHashes(dir, task.protect);
    writeFileSync(join(dir, "tests/range.test.ts"), "// edited\n");
    expect(protectedHashes(dir, task.protect)).not.toEqual(base);
    rmSync(dir, { recursive: true, force: true });
    const d2 = prepare(task);
    writeFileSync(join(d2, "tests/extra.test.ts"), "x");
    expect(Object.keys(protectedHashes(d2, task.protect)).sort()).toEqual(["tests/extra.test.ts", "tests/range.test.ts"]);
    rmSync(d2, { recursive: true, force: true });
  });
});

describe("running a task end to end", () => {
  type Behaviour = "solve" | "lazy" | "tamper" | "down" | "hang";
  let behaviour: Behaviour = "solve";
  let solution: Record<string, string> = {};
  let server: ReturnType<typeof Bun.serve>;
  const enc = new TextEncoder();

  beforeAll(() => {
    const sse = (chunks: unknown[]) => new Response(new ReadableStream({ start(c) { for (const x of chunks) c.enqueue(enc.encode(`data: ${JSON.stringify(x)}\n\n`)); c.enqueue(enc.encode("data: [DONE]\n\n")); c.close(); } }), { headers: { "content-type": "text/event-stream" } });
    const usage = { choices: [], usage: { prompt_tokens: 200, completion_tokens: 12 } };
    const write = (file: string, content: string) => sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: `c_${Math.random().toString(36).slice(2)}`, type: "function", function: { name: "Write", arguments: JSON.stringify({ file_path: file, content }) } }] } }] }, { choices: [{ delta: {}, finish_reason: "tool_calls" }] }, usage]);
    const say = (t: string) => sse([{ choices: [{ delta: { content: t } }] }, { choices: [{ delta: {}, finish_reason: "stop" }] }, usage]);
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const body: any = await req.json();
        if (!body.stream) return Response.json({ choices: [{ message: { content: "SUMMARY" } }] });
        if (behaviour === "down") return new Response("model is down", { status: 500 });
        if (behaviour === "hang") return new Promise<Response>(() => {});
        const written = body.messages.filter((m: any) => m.role === "tool").length;
        if (behaviour === "lazy") return say("I looked at it and everything seems fine.");
        if (behaviour === "tamper") return written === 0 ? write("tests/range.test.ts", 'import { test } from "bun:test";\ntest("ok", () => {});\n') : say("done");
        const files = Object.entries(solution);
        const next = files[written];
        return next ? write(next[0], next[1]) : say("fixed");
      },
    });
  });
  afterAll(() => server.stop(true));

  const env = () => ({ HOME: state, XDG_STATE_HOME: state, XDG_CONFIG_HOME: state, NAVVIED_BASE_URL: `http://127.0.0.1:${server.port}/v1`, NAVVIED_MODEL: "scripted", NAVVIED_WINDOW: "100000" });
  const run = (task: Task) => runTask(task, { command: ["bun", CLI], env: env() });
  const pick = (id: string) => { const t = loadTasks(TASKS, [id])[0]!; solution = solutionFiles(t); return t; };

  test("a model that writes the right files solves the task, and the metrics reflect the work", async () => {
    behaviour = "solve";
    const r = await run(pick("fix-off-by-one"));
    expect(r).toMatchObject({ task: "fix-off-by-one", passed: true, reason: "solved", exitCode: 0, toolCalls: 1 });
    expect(r.modelCalls).toBe(2);
    expect(r.outTokens).toBe(24);
    expect(r.peakContext).toBeGreaterThan(0);
    expect(r.ms).toBeGreaterThan(0);
  });

  test("a multi-file task is solved the same way", async () => {
    behaviour = "solve";
    const r = await run(pick("rename-across-files"));
    expect(r).toMatchObject({ passed: true, toolCalls: 3, modelCalls: 4 });
  });

  test("a model that changes nothing fails the check", async () => {
    behaviour = "lazy";
    const r = await run(pick("fix-sort-order"));
    expect(r).toMatchObject({ passed: false, reason: "check failed", toolCalls: 0 });
  });

  test("rewriting the tests is caught, even though the tests then pass", async () => {
    behaviour = "tamper";
    const r = await run(pick("fix-off-by-one"));
    expect(r).toMatchObject({ passed: false, reason: "protected files changed" });
  });

  test("an unreachable model is reported with its error", async () => {
    behaviour = "down";
    const r = await run(pick("fix-off-by-one"));
    expect(r).toMatchObject({ passed: false, reason: "agent failed", exitCode: 1 });
    expect(r.error).toMatch(/the model endpoint answered 500/);
  });

  test("a hung model is stopped at the time limit", async () => {
    behaviour = "hang";
    const task = { ...pick("fix-off-by-one"), timeoutSeconds: 2 };
    const started = Date.now();
    const r = await run(task);
    expect(r).toMatchObject({ passed: false, reason: "timeout" });
    expect(Date.now() - started).toBeLessThan(8000);
  });

  test("the workspace can be kept for inspection, and is removed otherwise", async () => {
    behaviour = "solve";
    const kept = await runTask(pick("fix-off-by-one"), { command: ["bun", CLI], env: env(), keep: true });
    expect(existsSync(kept.workspace!)).toBe(true);
    expect(readFileSync(join(kept.workspace!, "src/range.ts"), "utf8")).toContain("<=");
    rmSync(kept.workspace!, { recursive: true, force: true });
    const gone = await run(pick("fix-off-by-one"));
    expect(gone.workspace).toBeUndefined();
  });
});

describe("report", () => {
  const r = (task: string, model: string, passed: boolean, ms = 1000): TaskResult => ({ task, model, passed, reason: passed ? "solved" : "check failed", ms, modelCalls: 4, toolCalls: 3, outTokens: 100, peakContext: 500, exitCode: 0 });
  test("one row per model and a pass grid per task", () => {
    const text = summarize([r("a", "m1", true), r("b", "m1", false), r("a", "m2", true, 3000), r("b", "m2", true, 3000)]);
    expect(text).toContain("| m1 | 1/2 (50%) | 1.0s | 4.0 | 3.0 | 100 |");
    expect(text).toContain("| m2 | 2/2 (100%) | 3.0s |");
    expect(text).toContain("| a | pass | pass |");
    expect(text).toContain("| b | fail (check failed) | pass |");
  });
  test("repeated runs show a ratio; a missing cell is a dash", () => {
    const text = summarize([r("a", "m1", true), r("a", "m1", false), r("a", "m1", true), r("b", "m2", true)]);
    expect(text).toContain("| a | 2/3 | - |");
    expect(text).toContain("| b | - | pass |");
  });
  test("no results is not an error", () => expect(() => summarize([])).not.toThrow());
});
