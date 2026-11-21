import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { main } from "../src/main.ts";
import { loadTasks, parseAdapter, runTask, startMeter, startMock, type Behaviour, type Meter, type Mock, type Task } from "../src/index.ts";
import { HOOK_MS, hook, removeTree } from "../../protocol/test/support/cleanup.ts";

const TASKS = join(import.meta.dir, "../tasks");
const CLI = join(import.meta.dir, "../../cli/src/main.ts");
const home = mkdtempSync(join(tmpdir(), "navvied-bench-home-"));
// The build of the terminal task is short here; a real run leaves it as it is.
process.env.BUILD_SECONDS = "2";
const tasks = loadTasks(TASKS);
let behaviour: Behaviour = "oracle";
let mock: Mock, meter: Meter;
beforeAll(() => { mock = startMock(tasks, () => behaviour); meter = startMeter(mock.url); });
afterAll(hook("bench removes what it made", async () => { meter.stop(); mock.stop(); await removeTree(home); }), HOOK_MS);

const world = { HOME: home, XDG_STATE_HOME: home, XDG_CONFIG_HOME: home, NAVVIED_MODEL: "scripted", NAVVIED_WINDOW: "100000", NAVVIED_RETRIES: "0" };
const run = (task: Task, how: Behaviour) => { behaviour = how; mock.requests.length = 0; return runTask(task, { command: ["bun", CLI], label: `mock:${how}`, env: world, meter, agentEnv: (base) => ({ NAVVIED_BASE_URL: base }) }); };
/** What still runs by this name once the system has had a moment to remove what was killed (it is waited for, not guessed at). */
async function gone(name: string): Promise<string> {
  let left = "";
  for (let i = 0; i < 60; i++) { left = Bun.spawnSync(["pgrep", "-f", name]).stdout.toString().trim(); if (!left) break; await Bun.sleep(50); }
  return left;
}
const pick = (id: string): Task => tasks.find((t) => t.id === id)!;

describe("every task can be solved by an agent run, not only by the validator", () => {
  test("the scripted model that does what the reference solution does solves all of them, through the real program", async () => {
    for (const task of tasks) {
      const r = await run(task, "oracle");
      expect(r, task.id).toMatchObject({ passed: true, reason: "solved" });
      // Whatever the task says, the first request stays light: a task is never a reason to send the long text about the program.
      // A web task also offers the two web tools (about 440 characters, and a seventh and eighth tool); the one that says a browser can read what a plain fetch cannot also offers the browser, whose text is the longest.
      const web = task.kind === "web";
      expect(r.prompt!.systemChars + r.prompt!.toolChars, task.id).toBeLessThanOrEqual(task.id === "web-script-page" ? 4500 : web ? 3400 : 3000);
      expect(r.prompt!.tools, task.id).toBeLessThanOrEqual(web ? 8 : 6);
    }
  }, 240_000);
});

describe("what is measured per run", () => {
  test("calls and tokens are the counter's and equal what the model saw and said; the prompt weight and the memory are there", async () => {
    const r = await run(pick("rename-across-files"), "oracle");
    expect(r.passed).toBe(true);
    expect(r.modelCalls).toBe(mock.requests.length);
    expect(r.inTokens).toBe(mock.requests.reduce((n, q) => n + q.prompt, 0));
    expect(r.outTokens).toBe(mock.requests.reduce((n, q) => n + q.completion, 0));
    expect(r.estimated).toBe(false);
    expect(r.largest!.requestBytes).toBeGreaterThanOrEqual(r.prompt!.requestBytes);
    expect(r.largest!.status).toBe(200);
    expect(r.misuse).toEqual({ badCalls: 0, polls: 0, cdCalls: 0 });
    expect(r.firstRequestMs).toBeGreaterThanOrEqual(0);
    expect(r.prompt!.tools).toBeGreaterThan(0);
    expect(r.prompt!.systemChars).toBeGreaterThan(0);
    expect(r.prompt!.toolChars).toBeGreaterThan(r.prompt!.tools * 10);
    expect(r.prompt!.requestBytes).toBeGreaterThan(r.prompt!.systemChars);
    if (process.platform !== "win32") { expect(r.peakMb).toBeGreaterThan(5); expect(r.peakTreeMb).toBeGreaterThanOrEqual(r.peakMb!); }
  }, 60_000);
});

describe("how heavy the first request is", () => {
  test("the system prompt and the tool definitions together are at most 3,000 characters, and at most six tools are offered", async () => {
    const r = await run(pick("fix-off-by-one"), "oracle");
    expect(r.prompt!.tools).toBeLessThanOrEqual(6);
    expect(r.prompt!.systemChars + r.prompt!.toolChars).toBeLessThanOrEqual(3000);
  }, 60_000);
});

describe("every way a run can fail is seen", () => {
  test("a model that does nothing: the check fails", async () => {
    expect(await run(pick("fix-off-by-one"), "lazy")).toMatchObject({ passed: false, reason: "check failed", toolCalls: 0 });
  }, 60_000);
  test("a model that rewrites the tests: protected files changed", async () => {
    expect(await run(pick("fix-off-by-one"), "tamper")).toMatchObject({ passed: false, reason: "protected files changed" });
  }, 60_000);
  test("a model endpoint that is down: the agent failed", async () => {
    expect(await run(pick("fix-off-by-one"), "crash")).toMatchObject({ passed: false, reason: "agent failed" });
  }, 60_000);
  test("a model that never answers: the time limit, and the program is stopped", async () => {
    const started = Date.now();
    const r = await run({ ...pick("fix-off-by-one"), timeoutSeconds: 2 }, "hang");
    expect(r).toMatchObject({ passed: false, reason: "timeout", checkedAtTimeout: false });
    expect(Date.now() - started).toBeLessThan(15_000);
    // The agent was stopped while the model had not answered: that is the run's time running out, not the model failing.
    expect(r.modelErrors ?? 0).toBe(0);
    expect(r.largest).toMatchObject({ status: 499 });
  }, 60_000);
  test("an agent that had done the task and only waited for its last answer is a timeout, and the check says it was done", async () => {
    const r = await run({ ...pick("fix-off-by-one"), timeoutSeconds: 4 }, "stall");
    expect(r).toMatchObject({ passed: false, reason: "timeout", checkedAtTimeout: true });
    expect(r.modelErrors ?? 0).toBe(0);
  }, 60_000);
  test.skipIf(process.platform !== "linux")("a model that leaves a program running: not solved, and the program is stopped", async () => {
    expect(await run(pick("fix-off-by-one"), "leave")).toMatchObject({ passed: false, reason: "left a process running" });
    expect(await gone(mock.leaves)).toBe("");
  }, 60_000);
});

describe("another agent, described by a file", () => {
  test("is started as its file says, in the workspace, and counted by the counter all the same; what it does itself is not read", async () => {
    // A stand-in agent: asks the model once at the address it was given, then does what the reference solution does.
    const script = join(home, "other-agent.ts");
    writeFileSync(script, `
      import { applySolution, loadTasks } from ${JSON.stringify(join(import.meta.dir, "../src/index.ts"))};
      const [dir, base, key] = process.argv.slice(2);
      const task = loadTasks(${JSON.stringify(TASKS)}).find((t) => dir!.includes("navvied-eval-" + t.id + "-"))!;
      const res = await fetch(base + "/chat/completions", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + key }, body: JSON.stringify({ model: "m", stream: false, messages: [{ role: "system", content: "Work in " + dir }, { role: "user", content: "go" }] }) });
      if (!res.ok) process.exit(3);
      await applySolution(dir!, task);
    `);
    const agent = parseAdapter({ label: "other", argv: [process.execPath, script, "{dir}", "{base_url}", "{key}", "{prompt}"] });
    behaviour = "oracle";
    mock.requests.length = 0;
    const r = await runTask(pick("fix-off-by-one"), { command: ["unused"], agent, label: "other:mock", model: "scripted", key: "k1", env: world, meter });
    expect(r).toMatchObject({ task: "fix-off-by-one", model: "other:mock", passed: true, reason: "solved", modelCalls: 1, toolCalls: 0, kind: "fix", level: 1, lang: "ts" });
    expect(r.inTokens).toBeGreaterThan(0);
    expect(r.prompt).toMatchObject({ tools: 0 });
    // A short-lived stand-in is only certain to be seen where the system keeps its own high-water mark (Linux).
    if (process.platform === "linux") expect(r.peakMb).toBeGreaterThan(0);
  }, 60_000);

  test("one that cannot be pointed at the counter is still timed and checked, and has no calls to count", async () => {
    const agent = parseAdapter({ label: "blind", argv: [process.execPath, "-e", "0", "{prompt}"] });
    const r = await runTask(pick("fix-off-by-one"), { command: ["unused"], agent, env: world, meter });
    expect(r).toMatchObject({ passed: false, reason: "check failed", modelCalls: 0, model: "default" });
    expect(r.inTokens).toBeUndefined();
  }, 60_000);
});

describe("the run command with a scripted model", () => {
  test("starts our program at the counter, with the model named in the environment, and writes what it measured", async () => {
    const out = join(home, "run.jsonl");
    const written: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => { written.push(String(chunk)); return true; }) as typeof process.stdout.write;
    let code: number;
    try { code = await main(["run", "--mock", "oracle", "--tasks", "fix-off-by-one", "--out", out]); } finally { process.stdout.write = write; }
    expect(code).toBe(0);
    const r = JSON.parse(readFileSync(out, "utf8").trim().split("\n")[0]!);
    expect(r).toMatchObject({ task: "fix-off-by-one", model: "mock:oracle", passed: true, reason: "solved" });
    expect(r.modelCalls).toBeGreaterThan(0);
    expect(r.inTokens).toBeGreaterThan(0);
    expect(written.join("")).toContain("| mock:oracle | 1/1 (100%)");
  }, 60_000);
});

describe("what a failed run says about itself", () => {
  test("the agent's last words, its steps and the check's output are kept; a key it was given never is", async () => {
    behaviour = "leak";
    const r = await runTask(pick("fix-sort-order"), { command: ["bun", CLI], label: "mock:leak", env: { ...world, NAVVIED_API_KEY: "not-a-real-key-123" }, meter, agentEnv: (base) => ({ NAVVIED_BASE_URL: base }) });
    expect(r.passed).toBe(false);
    expect(r.why!.said).toBe("The key I was given is Bearer [key].");
    expect(r.why!.check.length).toBeGreaterThan(0);
    expect(JSON.stringify(r)).not.toContain("not-a-real-key-123");
  }, 60_000);
});
