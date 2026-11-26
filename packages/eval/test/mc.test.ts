import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
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

describe("mc-triage-logs: \"the file name is the service\" reads as auth and as auth.log", () => {
  const task = tasks.find((t) => t.id === "mc-triage-logs")!;
  type Entry = { errors: number; first_failing_request: string };
  /** Runs the task's check on a report made from the right one. */
  async function judge(reports: (right: [string, Entry][]) => Record<string, string>): Promise<Record<string, boolean>> {
    const dir = prepare(task);
    const env = scriptEnv({ BENCH_SECRET: "triage-secret" });
    try {
      expect((await shell(dir, task.setup!, env)).ok).toBe(true);
      await applySolution(dir, task, env);
      const right = Object.entries(JSON.parse(readFileSync(join(dir, "triage.json"), "utf8")) as Record<string, Entry>);
      expect(right).toHaveLength(8);
      const out: Record<string, boolean> = {};
      for (const [what, text] of Object.entries(reports(right))) {
        writeFileSync(join(dir, "triage.json"), text);
        out[what] = (await check(dir, task, 120_000, env)).ok;
      }
      return out;
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  const report = (entries: [string, unknown][]): string => JSON.stringify(Object.fromEntries(entries));
  const logged = (entries: [string, Entry][]): [string, Entry][] => entries.map(([k, v]) => [`${k}.log`, v]);

  test("each key may be the service or its file name", async () => {
    expect(await judge((right) => ({
      bare: report(right),
      files: report(logged(right)),
      mixed: report([...logged(right.slice(0, 3)), ...right.slice(3)]),
    }))).toEqual({ bare: true, files: true, mixed: true });
  }, 60_000);

  test("everything else stays exact: the same services once each, with the same values", async () => {
    const got = await judge((right) => {
      const files = logged(right);
      const [name, entry] = files[0]!;
      const rest = files.slice(1);
      return {
        missing: report(rest),
        extra: report([...files, ["proxy.log", entry]]),
        bothWays: report([...files, right[0]!]),
        bothWaysInsteadOfAnother: report([right[0]!, ...files.slice(0, 7)]),
        writtenTwice: `{${JSON.stringify(name)}:${JSON.stringify(entry)},${report(files).slice(1)}`,
        folder: report(files.map(([k, v]) => [`logs/${k}`, v])),
        otherEnding: report(right.map(([k, v]) => [`${k}.txt`, v])),
        doubleEnding: report(logged(files)),
        wrongCount: report([[name, { ...entry, errors: entry.errors + 1 }], ...rest]),
        wrongRequest: report([[name, { ...entry, first_failing_request: "req-0000000000" }], ...rest]),
        endingInside: report([[name, { "errors.log": entry.errors, first_failing_request: entry.first_failing_request }], ...rest]),
        extraField: report([[name, { ...entry, note: "x" }], ...rest]),
        list: JSON.stringify(right),
      };
    });
    expect(Object.entries(got).filter(([, ok]) => ok)).toEqual([]);
    expect(Object.keys(got)).toHaveLength(13);
  }, 60_000);
});
