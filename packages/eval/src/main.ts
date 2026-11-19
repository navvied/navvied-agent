#!/usr/bin/env bun
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { summarize } from "./report.ts";
import { runTask, type TaskResult } from "./run.ts";
import { loadTasks, type Task } from "./task.ts";
import { applySolution, check, prepare, protectedHashes } from "./workspace.ts";

const HERE = dirname(import.meta.path);
const TASKS = join(HERE, "../tasks");
const CLI = join(HERE, "../../cli/src/main.ts");

const USAGE = `navvied-eval — measure a coding agent on real tasks

  navvied-eval list
  navvied-eval validate [--tasks a,b]        every task must fail untouched and pass with its reference solution
  navvied-eval run --model <name> [--model <name> …] [--tasks a,b] [--repeat n] [--out results.jsonl] [--cli "<command>"]
  navvied-eval report <results.jsonl>
`;

function option(args: string[], name: string): string[] {
  const out: string[] = [];
  args.forEach((a, i) => { if (a === `--${name}` && args[i + 1]) out.push(args[i + 1]!); else if (a.startsWith(`--${name}=`)) out.push(a.slice(name.length + 3)); });
  return out;
}

async function validate(tasks: Task[]): Promise<number> {
  let bad = 0;
  for (const task of tasks) {
    const dir = prepare(task);
    const before = protectedHashes(dir, task.protect);
    const untouched = await check(dir, task);
    applySolution(dir, task);
    const solved = await check(dir, task);
    const intact = JSON.stringify(Object.entries(before).sort()) === JSON.stringify(Object.entries(protectedHashes(dir, task.protect)).sort());
    const problems = [untouched.ok ? "passes before any change" : "", solved.ok ? "" : "fails with its solution", intact ? "" : "the solution changes protected files"].filter(Boolean);
    process.stdout.write(`${problems.length ? "FAIL" : "ok  "} ${task.id}${problems.length ? `: ${problems.join("; ")}` : ""}\n`);
    if (problems.length) bad += 1;
  }
  return bad ? 1 : 0;
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const only = option(rest, "tasks").flatMap((s) => s.split(",")).filter(Boolean);
  switch (command) {
    case "list": for (const t of loadTasks(TASKS)) process.stdout.write(`${t.id}  ${t.title}\n`); return 0;
    case "validate": return validate(loadTasks(TASKS, only));
    case "run": {
      const models = option(rest, "model");
      if (!models.length) { process.stderr.write(`error: give at least one --model\n\n${USAGE}`); return 2; }
      const repeat = Math.max(1, Number(option(rest, "repeat")[0] ?? 1) || 1);
      const out = option(rest, "out")[0];
      const cli = option(rest, "cli")[0];
      const command = cli ? cli.split(/\s+/) : ["bun", CLI];
      if (out) writeFileSync(out, "");
      const results: TaskResult[] = [];
      for (const task of loadTasks(TASKS, only)) {
        for (const model of models) {
          for (let i = 0; i < repeat; i++) {
            const r = await runTask(task, { command, model });
            results.push(r);
            if (out) appendFileSync(out, `${JSON.stringify(r)}\n`);
            process.stderr.write(`${r.passed ? "pass" : "FAIL"}  ${task.id}  ${model}  ${(r.ms / 1000).toFixed(1)}s  ${r.modelCalls} calls${r.passed ? "" : `  (${r.reason})`}\n`);
          }
        }
      }
      process.stdout.write(`\n${summarize(results)}\n`);
      return results.every((r) => r.passed) ? 0 : 1;
    }
    case "report": {
      const file = rest[0];
      if (!file) { process.stderr.write(USAGE); return 2; }
      process.stdout.write(`${summarize(readFileSync(resolve(file), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as TaskResult))}\n`);
      return 0;
    }
    default: process.stderr.write(USAGE); return command ? 2 : 0;
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
