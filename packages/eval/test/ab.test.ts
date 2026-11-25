import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ASSUMED, estimateRun, estimateTable } from "../src/ab-estimate.ts";
import { median, summarizeAb, type AbRun } from "../src/ab-report.ts";
import { main, orderFor, plan } from "../src/ab.ts";
import { HOOK_MS, hook, removeTree } from "../../protocol/test/support/cleanup.ts";

const state = mkdtempSync(join(tmpdir(), "navvied-ab-test-"));
afterAll(hook("the comparison test removes what it made", async () => { await removeTree(state); }), HOOK_MS);

const real = ["--upstream", "http://127.0.0.1:1/v1", "--upstream-model", "m", "--upstream-key-file", "/nonexistent/key", "--max-tokens", "1000"];

describe("nothing is spent by accident", () => {
  test("a real run is refused without --yes-spend, and says what it would have done", () => {
    const p = plan([...real, "--tasks", "mc-triage-logs", "--repeat", "2"]);
    expect(typeof p).toBe("string");
    expect(p).toContain("nothing was sent");
    expect(p).toContain("12 runs".replace("12", "4"));
    expect(p).toContain("--yes-spend");
  });

  test("it needs the address, the model, the key file and a limit on the tokens", () => {
    expect(plan(["--yes-spend"])).toContain("--upstream, --upstream-model, --upstream-key-file, --max-tokens");
    expect(plan([...real.slice(0, 6), "--yes-spend"])).toContain("--max-tokens");
    expect(plan([...real.slice(0, 6), "--max-tokens", "0", "--yes-spend"])).toContain("above zero");
  });

  test("with every flag it is a plan; the key is a path in it and never its content", () => {
    const p = plan([...real, "--yes-spend"]);
    expect(typeof p).toBe("object");
    const text = JSON.stringify(p, (_k, v) => (typeof v === "object" && v && "prompt" in v ? undefined : v));
    expect(text).toContain("/nonexistent/key");
    expect(p).toMatchObject({ dry: false, arms: ["base", "code"], repeat: 3, perMinute: 20, maxTokens: 1000 });
  });

  test("the dry run and the estimate need nothing and use the six multi-call tasks", () => {
    for (const flag of ["--dry", "--estimate"]) {
      const p = plan([flag]);
      expect(typeof p).toBe("object");
      expect((p as { tasks: { id: string }[] }).tasks.map((t) => t.id).sort()).toEqual(Object.keys(ASSUMED).filter((id) => id.startsWith("mc-")).sort());
    }
  });

  test("an unknown arm or task is an error", () => {
    expect(plan(["--dry", "--arms", "base,fast"])).toContain("--arms");
    expect(plan(["--dry", "--tasks", "nope"])).toContain("unknown task");
  });

  test("the arms change places with every repeat", () => {
    expect([0, 1, 2, 3].map((r) => orderFor(["base", "code"], r).join(">"))).toEqual(["base>code", "code>base", "base>code", "code>base"]);
  });
});

const run = (task: string, arm: string, repeat: number, o: Partial<AbRun>): AbRun => ({ task, arm, repeat, model: arm, passed: true, reason: "solved", ms: 10_000, modelCalls: 10, toolCalls: 10, outTokens: 100, peakContext: 0, exitCode: 0, inTokens: 1000, ...o });

describe("the summary", () => {
  test("the middle is of the repeats and the difference is paired, with its lowest and highest", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    const runs = [
      run("t", "base", 0, { modelCalls: 10 }), run("t", "code", 0, { modelCalls: 6 }),
      run("t", "base", 1, { modelCalls: 12 }), run("t", "code", 1, { modelCalls: 5 }),
      run("t", "base", 2, { modelCalls: 8, passed: false, reason: "check failed" }), run("t", "code", 2, { modelCalls: 7, ms: 15_000, waitedMs: 5_000 }),
    ];
    const text = summarizeAb(runs, ["base", "code"]);
    const row = text.split("\n").find((l) => l.startsWith("| t |"))!;
    expect(row).toContain("2/3 (67%");
    expect(row).toContain("3/3 (100%");
    // paired: 6-10=-4, 5-12=-7, 7-8=-1: the middle is -4, the spread -7 to -1; the base arm's middle is 10, the code arm's 6.
    expect(row).toContain("| 10.0 | 6.0 | -4.0 (-7.0 to -1.0) |");
    // seconds are the agent's own: the 5 s the counter waited are not in them.
    expect(row).toContain("| 10.0 | 10.0 | 0.0 (-0.0 to 0.0) |".replace("-0.0 to 0.0", "0.0 to 0.0")); // 10 s, 10 s, 10 s - 0: all equal
    expect(text).toContain("t base repeat 3: check failed");
    expect(text).toContain("all 1 tasks");
  });

  test("a repeat that one arm lacks is left out of the pairs, not guessed", () => {
    const text = summarizeAb([run("t", "base", 0, {}), run("t", "code", 0, { modelCalls: 4 }), run("t", "base", 1, {})], ["base", "code"]);
    expect(text.split("\n").find((l) => l.startsWith("| t |"))).toContain("| 10.0 | 4.0 | -6.0 (-6.0 to -6.0) |");
  });
});

describe("the estimate", () => {
  test("a run sends the whole conversation with every call: the first request, then what each step added", () => {
    const e = estimateRun("mc-config-diff", "code", 1000);
    const { calls, added } = ASSUMED["mc-config-diff"]!.code;
    expect(e.inTokens).toBe(calls * 1000 + (added * calls * (calls - 1)) / 2);
    expect(e.calls).toBe(calls);
    expect(e.outTokens).toBe(calls * 70 + 400);
    expect(estimateRun("mc-paginated-api", "stepwise", 1000).outTokens).toBe(16 * 70 + 3600);
  });

  test("the stepwise arm of the tasks is built to take at least fifteen calls, a script three or four", () => {
    for (const [task, shapes] of Object.entries(ASSUMED).filter(([id]) => id.startsWith("mc-"))) {
      expect(shapes.stepwise.calls, task).toBeGreaterThanOrEqual(15);
      expect(shapes.code.calls, task).toBeLessThanOrEqual(6);
    }
  });

  test("the table totals both arms over every repeat and says how long the rate limit makes it take", () => {
    const first = Object.fromEntries(Object.keys(ASSUMED).filter((t) => t.startsWith("mc-")).map((t) => [t, { base: 1800, code: 2100 }]));
    const table = estimateTable(first, 3, 20);
    expect(table).toContain("For 6 tasks, both arms, 3 repeats:");
    expect(table).toMatch(/minutes at 20 requests a minute/);
  });
});

/** The program under test says what it does on both outputs; the tests do not need it. */
async function quietly<T>(work: () => Promise<T>): Promise<T> {
  const out = process.stdout.write, err = process.stderr.write;
  process.stdout.write = (() => true) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try { return await work(); } finally { process.stdout.write = out; process.stderr.write = err; }
}

describe("the dry run, through the real program", () => {
  test("both arms solve a task with the scripted model; only the code arm runs a script; nothing is spent", async () => {
    const out = join(state, "dry.jsonl");
    const code = await quietly(() => main(["--dry", "--tasks", "mc-triage-logs", "--repeat", "2", "--out", out]));
    expect(code).toBe(0);
    const rows = readFileSync(out, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as AbRun);
    expect(rows.map((r) => `${r.repeat}:${r.arm}`)).toEqual(["0:base", "0:code", "1:code", "1:base"]);
    for (const r of rows) expect(r).toMatchObject({ task: "mc-triage-logs", passed: true, reason: "solved" });
    const base = rows.filter((r) => r.arm === "base"), codeRuns = rows.filter((r) => r.arm === "code");
    for (const r of base) { expect(r.tools?.ExecuteCode).toBeUndefined(); expect(r.nestedCalls ?? 0).toBe(0); expect(r.prompt!.tools).toBeLessThan(codeRuns[0]!.prompt!.tools); }
    for (const r of codeRuns) { expect(r.tools?.ExecuteCode).toBe(1); expect(r.nestedCalls).toBeGreaterThanOrEqual(2); }
  }, 60_000);

  test("a run that was stopped is resumed: what is done is not run again", async () => {
    const out = join(state, "resume.jsonl");
    const done: AbRun = { ...run("mc-triage-logs", "base", 0, {}), model: "scripted:base" };
    writeFileSync(out, `${JSON.stringify(done)}\n`);
    expect(await quietly(() => main(["--dry", "--tasks", "mc-triage-logs", "--repeat", "1", "--out", out, "--resume"]))).toBe(0);
    const rows = readFileSync(out, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as AbRun);
    expect(rows.map((r) => `${r.repeat}:${r.arm}`)).toEqual(["0:base", "0:code"]);
  }, 60_000);
});
