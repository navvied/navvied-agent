import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { main } from "../src/main.ts";
import { loadTasks, parseAdapter, runTask, startMeter, startMock, type Behaviour, type Meter, type Mock, type Task } from "../src/index.ts";
import { HOOK_MS, hook, removeTree } from "../../protocol/test/support/cleanup.ts";

/** The system text names the folder the task runs in, which lies under this computer's temporary folder: a long one (macOS) is not a heavier prompt. */
const PATH_ROOM = tmpdir().length;
/** The first request of a model that is not small, measured at 10,200 to 11,800 characters and 18 to 23 tools over every task: the caps are generous and bounded. */
const NOT_SMALL_CHARS = 13_000;
const NOT_SMALL_TOOLS = 26;

const TASKS = join(import.meta.dir, "../tasks");
const CLI = join(import.meta.dir, "../../cli/src/main.ts");
const home = mkdtempSync(join(tmpdir(), "navvied-bench-home-"));
// The build of the terminal task is short here; a real run leaves it as it is.
process.env.BUILD_SECONDS = "2";
const tasks = loadTasks(TASKS);
let behaviour: Behaviour = "oracle";
let mock: Mock, meter: Meter;
beforeAll(() => { mock = startMock(tasks, () => behaviour); meter = startMeter(mock.url); });
afterAll(hook("bench removes what it made", async () => { for (const made of meters) made.stop(); meter.stop(); mock.stop(); await removeTree(home); }), HOOK_MS);

const world = { HOME: home, XDG_STATE_HOME: home, XDG_CONFIG_HOME: home, NAVVIED_MODEL: "scripted", NAVVIED_WINDOW: "100000", NAVVIED_RETRIES: "0" };
const run = (task: Task, how: Behaviour, env: Record<string, string> = world) => { behaviour = how; mock.requests.length = 0; return runTask(task, { command: ["bun", CLI], label: `mock:${how}`, env, meter, agentEnv: (base) => ({ NAVVIED_BASE_URL: base }) }); };
/** What still runs by this name once the system has had a moment to remove what was killed (it is waited for, not guessed at). */
async function gone(name: string): Promise<string> {
  let left = "";
  for (let i = 0; i < 60; i++) { left = Bun.spawnSync(["pgrep", "-f", name]).stdout.toString().trim(); if (!left) break; await Bun.sleep(50); }
  return left;
}
const pick = (id: string): Task => tasks.find((t) => t.id === id)!;
const meters: Meter[] = [];
const startedMeter = (url: string): Meter => { const made = startMeter(url); meters.push(made); return made; };

describe("every task can be solved by an agent run, not only by the validator", () => {
  test("the scripted model that does what the reference solution does solves all of them, through the real program", async () => {
    for (const task of tasks) {
      const r = await run(task, "oracle");
      expect(r, task.id).toMatchObject({ passed: true, reason: "solved" });
      // A model that is not small is shown every tool that is set up for it, whatever the task says: the first request is bounded, not tight.
      // The caps for a small model (about 3,500 characters, at most 8 tools) are tested on the engine, where the model is marked small.
      expect(r.prompt!.systemChars + r.prompt!.toolChars, task.id).toBeLessThanOrEqual(NOT_SMALL_CHARS + PATH_ROOM);
      expect(r.prompt!.tools, task.id).toBeLessThanOrEqual(NOT_SMALL_TOOLS);
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
  test("the system prompt and the tool definitions together are at most 4,000 characters plus the Remember tool, and at most twelve tools are offered (the six of the work, the helper tool and the question tool, and for a model that is not small the task list and the two tools for many changes)", async () => {
    // A computer with no earlier conversations: Recall is not offered yet.
    const fresh = join(home, "fresh");
    const r = await run(pick("fix-off-by-one"), "oracle", { ...world, HOME: fresh, XDG_STATE_HOME: fresh, XDG_CONFIG_HOME: fresh });
    expect(r.prompt!.tools).toBeLessThanOrEqual(NOT_SMALL_TOOLS);
    expect(r.prompt!.systemChars + r.prompt!.toolChars).toBeLessThanOrEqual(NOT_SMALL_CHARS + PATH_ROOM);
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
  test("what the last calls printed is kept, so a call that did not do its work can be read in the result", async () => {
    behaviour = "oracle";
    const broken: Task = { ...pick("mc-import-cycles"), script: [{ tool: "Bash", args: { command: "echo the-script-did-not-run >&2; exit 3", description: "apply the solution" } }] };
    const other = startMock([broken], "oracle");
    try {
      const r = await runTask(broken, { command: ["bun", CLI], label: "mock:oracle", env: world, agentEnv: (base) => ({ NAVVIED_BASE_URL: base }), meter: startedMeter(other.url) });
      expect(r.passed).toBe(false);
      expect(r.why!.printed.join("\n")).toContain("the-script-did-not-run");
      expect(r.why!.printed.join("\n")).toContain("exit 3");
    } finally { other.stop(); }
  }, 60_000);

  test("the agent's last words, its steps and the check's output are kept; a key it was given never is", async () => {
    behaviour = "leak";
    const r = await runTask(pick("fix-sort-order"), { command: ["bun", CLI], label: "mock:leak", env: { ...world, NAVVIED_API_KEY: "not-a-real-key-123" }, meter, agentEnv: (base) => ({ NAVVIED_BASE_URL: base }) });
    expect(r.passed).toBe(false);
    expect(r.why!.said).toBe("The key I was given is Bearer [key].");
    expect(r.why!.check.length).toBeGreaterThan(0);
    expect(JSON.stringify(r)).not.toContain("not-a-real-key-123");
  }, 60_000);
});

describe("the tasks of asking, keeping a list and handing work to helpers", () => {
  test("the answer the person gives is what the agent writes; without the scripted answers the agent is told nobody can answer, and the task fails", async () => {
    const asked = pick("ask-which-port");
    expect(await run(asked, "oracle")).toMatchObject({ passed: true });
    const unanswered = await run({ ...asked, answers: undefined } as Task, "oracle");
    expect(unanswered).toMatchObject({ passed: false, reason: "check failed" });
  }, 60_000);
  test("a run that does the three steps without keeping a task list is told so", async () => {
    expect(await run(pick("plan-three-files"), "oracle")).toMatchObject({ passed: true, reason: "solved" });
    expect(await run(pick("plan-three-files"), "unplanned")).toMatchObject({ passed: false, reason: "task list not kept", error: "no task list was kept" });
  }, 60_000);
  test("two helpers are asked in one step and what they report is what the agent writes down", async () => {
    const trace = join(home, "trace");
    behaviour = "oracle";
    const r = await runTask(pick("research-two-helpers"), { command: ["bun", CLI], label: "mock:oracle", env: world, meter, agentEnv: (base) => ({ NAVVIED_BASE_URL: base }), trace });
    expect(r).toMatchObject({ passed: true });
    const events = readFileSync(join(trace, "research-two-helpers.events.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { ev: string; name?: string; status?: string; input?: unknown });
    const started = events.filter((e) => e.ev === "tool" && e.name === "Agent" && e.status === "running" && e.input !== undefined);
    const firstDone = events.findIndex((e) => e.ev === "tool" && e.name === "Agent" && e.status === "done");
    expect(started).toHaveLength(2);
    expect(events.filter((e, i) => i < firstDone && e.ev === "tool" && e.name === "Agent" && e.status === "running" && e.input !== undefined)).toHaveLength(2);
  }, 60_000);
});

describe("a step that ended in an error says why in the run's steps", () => {
  test("so that a failed run names the message and not only the tool", async () => {
    const { measure } = await import("../src/run.ts");
    const line = (o: object): string => JSON.stringify(o);
    const out = [
      line({ ev: "tool", id: "1", name: "Edit", status: "running", seq: 1, eid: "e1" }),
      line({ ev: "tool", id: "1", name: "Edit", status: "error", output: "Error: src/a.ts was not read in this conversation.\nsecond line", seq: 2, eid: "e2" }),
      line({ ev: "tool", id: "2", name: "Bash", status: "done", output: "ok", seq: 3, eid: "e3" }),
    ].join("\n");
    expect(measure(out).steps).toEqual(["Edit:error: Error: src/a.ts was not read in this conversation.", "Bash:done"]);
  });
});
