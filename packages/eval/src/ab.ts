#!/usr/bin/env bun
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { estimateTable } from "./ab-estimate.ts";
import { summarizeAb, type AbRun } from "./ab-report.ts";
import { startMeter, type Meter } from "./meter.ts";
import { startMock, type Mock } from "./mock.ts";
import { runTask } from "./run.ts";
import { loadTasks, type Task } from "./task.ts";
import { CLI, TASKS, agentWorld, codeTool, option } from "./world.ts";

const USAGE = `navvied-ab — does the code tool help? The same program and tasks, with and without it.

  bun packages/eval/src/ab.ts --dry [--tasks mc-…,mc-…] [--repeat n] [--arms base,code,auto]      the scripted model: checks the wiring, spends nothing
  bun packages/eval/src/ab.ts --estimate [--repeat n]                                        what a real measurement is expected to cost, spends nothing
  bun packages/eval/src/ab.ts --upstream <base address> --upstream-model <id> --upstream-key-file <file> --max-tokens <n> --yes-spend
        [--tasks mc-…,mc-…] [--repeat 3] [--arms base,code] [--out results.jsonl] [--resume] [--per-minute 20] [--upstream-window <tokens>] [--upstream-api chat|messages|responses] [--trace <folder>]

  base   the program as it is
  code   the same program with the code tool switched on and offered from the first request
  auto   the code row switched on and nothing else, as the product would run: the tool comes in when the turn shows it pays
  A real model costs tokens: nothing is sent without --yes-spend, and --max-tokens stops the run when the count reaches it.
  The key is read from the file into the environment of the agent only: never shown, never on a command line.
`;

const ARMS = ["base", "code", "auto"];
const DEFAULT_ARMS = ["base", "code"];
const WINDOW_DEFAULT = 100_000;

export interface Plan { dry: boolean; estimate: boolean; tasks: Task[]; arms: string[]; repeat: number; out?: string; resume: boolean; perMinute: number; window: number; maxTokens?: number; api?: string; upstream?: string; model?: string; keyFile?: string; trace?: string }

/** What the command line asks for, or why it cannot be done. Nothing is started here. */
export function plan(args: string[], tasksRoot = TASKS): Plan | string {
  const one = (name: string): string | undefined => option(args, name)[0];
  const dry = args.includes("--dry"), estimate = args.includes("--estimate");
  const wanted = option(args, "tasks").flatMap((s) => s.split(",")).filter(Boolean);
  let tasks: Task[];
  try { tasks = loadTasks(tasksRoot, wanted).filter((t) => wanted.length || t.id.startsWith("mc-")); } catch (e) { return `error: ${e instanceof Error ? e.message : String(e)}`; }
  if (!tasks.length) return "error: no task to run (the multi-call tasks are named mc-…)";
  const arms = (one("arms") ?? DEFAULT_ARMS.join(",")).split(",").filter(Boolean);
  if (arms.some((a) => !ARMS.includes(a)) || new Set(arms).size !== arms.length) return `error: --arms is a list of ${ARMS.join(", ")}, each once`;
  const repeat = Math.max(1, Number(one("repeat") ?? 3) || 1);
  const perMinute = Number(one("per-minute") ?? 20) || 20;
  const base = { dry, estimate, tasks, arms, repeat, resume: args.includes("--resume"), perMinute, window: Number(one("upstream-window") ?? WINDOW_DEFAULT) || WINDOW_DEFAULT, ...(one("upstream-api") ? { api: one("upstream-api")! } : {}), ...(one("out") ? { out: one("out")! } : {}), ...(one("trace") ? { trace: one("trace")! } : {}) };
  if (dry || estimate) return base;
  const missing = [["--upstream", one("upstream")], ["--upstream-model", one("upstream-model")], ["--upstream-key-file", one("upstream-key-file")], ["--max-tokens", one("max-tokens")]].filter(([, v]) => !v).map(([n]) => n);
  if (missing.length) return `error: a real run needs ${missing.join(", ")}`;
  const maxTokens = Number(one("max-tokens"));
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) return "error: --max-tokens is a number of tokens above zero";
  if (!args.includes("--yes-spend")) return `nothing was sent. This would run ${tasks.length * arms.length * repeat} runs (${tasks.length} tasks, ${arms.join(" and ")}, ${repeat} repeats) against a real model, up to ${maxTokens.toLocaleString("en-US")} tokens. Add --yes-spend to do it; --estimate says what it is expected to cost.`;
  return { ...base, maxTokens, upstream: one("upstream")!, model: one("upstream-model")!, keyFile: one("upstream-key-file")! };
}

const keyOf = (r: { task: string; arm: string; repeat: number }): string => `${r.task}/${r.arm}/${r.repeat}`;
/** The arms in the order they run in one repeat: the order turns round with each repeat, so the time of day and what the service has cached fall on both alike. */
export const orderFor = (arms: readonly string[], repeat: number): string[] => (repeat % 2 ? [...arms].reverse() : [...arms]);

/** The size of the first request of every task and arm, as the real program sends it to the scripted model. */
async function firstRequests(p: Plan, run: (task: Task, arm: string) => Promise<AbRun | undefined>): Promise<Record<string, { base: number; code: number }>> {
  const out: Record<string, { base: number; code: number }> = {};
  for (const task of p.tasks) {
    const [base, code] = [(await run(task, "base"))?.prompt?.requestBytes ?? 0, (await run(task, "code"))?.prompt?.requestBytes ?? 0];
    out[task.id] = { base: Math.ceil(base / 4), code: Math.ceil(code / 4) };
  }
  return out;
}

export async function main(argv: string[]): Promise<number> {
  if (argv.includes("--help") || !argv.length) { process.stderr.write(USAGE); return argv.length ? 0 : 2; }
  const p = plan(argv);
  if (typeof p === "string") { process.stderr.write(`${p}\n`); return p.startsWith("error") ? 2 : 0; }

  const scripted = p.dry || p.estimate;
  let arm = "base";
  let mock: Mock | undefined, meter: Meter | undefined;
  const home = mkdtempSync(join(tmpdir(), "navvied-ab-home-"));
  try {
    mock = scripted ? startMock(loadTasks(TASKS), () => (arm !== "base" ? "code" : "oracle")) : undefined;
    meter = startMeter(mock?.url ?? p.upstream!, scripted ? {} : { perMinute: p.perMinute, ...(p.maxTokens ? { maxTokens: p.maxTokens } : {}) });
    const key = p.keyFile ? readFileSync(resolve(p.keyFile), "utf8").trim() : undefined;
    const model = scripted ? "scripted" : p.model!;
    const world = agentWorld(home, model, p.window, key, p.api);

    const one = async (task: Task, which: string, repeat: number): Promise<AbRun | undefined> => {
      arm = which;
      codeTool(world, which !== "base", which === "code");
      const r = await runTask(task, { command: ["bun", CLI], label: `${model}:${which}`, env: world, meter: meter!, key: key ?? "none", agentEnv: (base) => ({ NAVVIED_BASE_URL: base }), ...(p.trace ? { trace: resolve(p.trace, which, `${repeat}`) } : {}) });
      // A run that was cut off by the limit is not a measurement of the model.
      return meter!.exhausted() ? undefined : { ...r, arm: which, repeat };
    };

    if (p.estimate) {
      const table = estimateTable(await firstRequests(p, (t, a) => one(t, a, 0)), p.repeat, p.perMinute);
      process.stdout.write(`${table}\n`);
      return 0;
    }

    const runs: AbRun[] = [];
    if (p.out) {
      if (p.resume && existsSync(p.out)) runs.push(...readFileSync(p.out, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as AbRun));
      else writeFileSync(p.out, "");
    }
    const done = new Set(runs.map(keyOf));
    let broken = 0;
    const total = p.tasks.length * p.arms.length * p.repeat;
    let stopped = false;
    loop: for (let repeat = 0; repeat < p.repeat; repeat++) {
      for (const task of p.tasks) {
        for (const which of orderFor(p.arms, repeat)) {
          if (done.has(keyOf({ task: task.id, arm: which, repeat }))) continue;
          if (broken >= 2) { process.stderr.write("stopped: the model failed on two runs in a row (server errors or no answer); look at it, then run again with --resume\n"); stopped = true; break loop; }
          const r = await one(task, which, repeat);
          if (!r) { process.stderr.write(`stopped: the limit of ${p.maxTokens?.toLocaleString("en-US")} tokens was reached during ${task.id} (${which}); that run is not counted. Run again with --resume and a higher --max-tokens to go on\n`); stopped = true; break loop; }
          runs.push(r);
          broken = r.modelErrors || r.reason === "timeout" ? broken + 1 : 0;
          if (p.out) appendFileSync(p.out, `${JSON.stringify(r)}\n`);
          process.stderr.write(`${r.passed ? "pass" : "FAIL"}  ${task.id}  ${which}  repeat ${repeat + 1}/${p.repeat}  ${((r.ms - (r.waitedMs ?? 0)) / 1000).toFixed(1)}s  ${r.modelCalls} calls  ${((r.inTokens ?? 0) + r.outTokens).toLocaleString("en-US")} tokens  (${runs.length}/${total}, ${meter.spent().toLocaleString("en-US")} tokens counted)${r.passed ? "" : `  (${r.reason})`}\n`);
        }
      }
    }
    process.stdout.write(`\n${summarizeAb(runs, p.arms)}\n`);
    // A real model that fails a task is a result; a scripted one that does is a wiring fault.
    return stopped || !runs.length || (scripted && runs.some((r) => !r.passed)) ? 1 : 0;
  } finally { meter?.stop(); mock?.stop(); rmSync(home, { recursive: true, force: true }); }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
