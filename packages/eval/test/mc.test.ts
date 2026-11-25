import { describe, expect, test } from "bun:test";
import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadTasks, solutionScript, type Task } from "../src/task.ts";
import { applySolution, check, killProcesses, leftovers, prepare, scriptEnv, shell } from "../src/workspace.ts";

const tasks = loadTasks(join(import.meta.dir, "../tasks")).filter((t) => t.id.startsWith("mc-"));
const count = (dir: string): number => readdirSync(dir).reduce((n, name) => { const p = join(dir, name); return n + (statSync(p).isDirectory() ? count(p) : 1); }, 0);

describe("the multi-call tasks", () => {
  test("there are six, each with a reference solution written for the code tool", () => {
    expect(tasks.map((t) => t.id).sort()).toEqual(["mc-aggregate-json", "mc-config-diff", "mc-import-cycles", "mc-migrate-calls", "mc-paginated-api", "mc-triage-logs"]);
    for (const t of tasks) expect(solutionScript(t), t.id).toContain("from navvied_tools import *");
  });

  test("a prompt stays under 400 characters, so it is not the reason a long-request tool is offered to one arm and not the other", () => {
    for (const t of tasks) expect(t.prompt.length, t.id).toBeLessThanOrEqual(400);
  });

  // The data comes from the run's secret: a solution run for one secret is not right for another, so no answer can be written down in advance.
  test.each(tasks.map((t) => [t.id, t] as const))("%s: its data is made in a moment, is many files or pages, and its check works from the secret", async (_id, task: Task) => {
    const dir = prepare(task);
    const mine = scriptEnv({ BENCH_SECRET: "secret-one" }), other = scriptEnv({ BENCH_SECRET: "secret-two" });
    try {
      const started = Date.now();
      const setup = await shell(dir, task.setup!, mine);
      expect(setup.ok, setup.output).toBe(true);
      expect(Date.now() - started).toBeLessThan(3000);
      // Sixty files, forty-five, eight (long) logs, thirty, eighty; the API has twelve pages.
      expect(count(dir) - 1, "files besides the readme").toBeGreaterThanOrEqual(task.id === "mc-triage-logs" ? 8 : task.id === "mc-paginated-api" ? 1 : 30);
      expect((await check(dir, task, 120_000, mine)).ok, "passes untouched").toBe(false);
      await applySolution(dir, task, mine);
      expect((await check(dir, task, 120_000, mine)).ok, "passes with its solution").toBe(true);
      expect((await check(dir, task, 120_000, other)).ok, "fails for another secret").toBe(false);
    } finally {
      killProcesses(leftovers(dir));
      if (task.teardown) await shell(dir, task.teardown, mine).catch(() => undefined);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
