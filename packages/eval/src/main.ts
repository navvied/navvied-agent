#!/usr/bin/env bun
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { agentsDir, listAdapters, loadAdapter, type Adapter } from "./adapter.ts";
import { footprint } from "./footprint.ts";
import { startMeter, type Meter } from "./meter.ts";
import { startMock, type Behaviour, type Mock } from "./mock.ts";
import { summarize } from "./report.ts";
import { runTask, type TaskResult } from "./run.ts";
import { loadTasks, type Task } from "./task.ts";
import { validateTask } from "./validate.ts";
import { CLI, TASKS, agentWorld, codeTool, option } from "./world.ts";

const USAGE = `navvied-eval — measure a coding agent on real tasks

  navvied-eval list
  navvied-eval validate [--tasks a,b] [--slow]      every task must fail untouched and pass with its reference solution
  navvied-eval run --model <name> [--model <name> …] [--tasks a,b] [--repeat n] [--out results.jsonl] [--cli "<command>"]
  navvied-eval run --mock oracle|code|lazy|tamper|leave|crash|hang [--tasks a,b] …   a scripted model: tries the tasks and the harness
  navvied-eval run --upstream <base address> --upstream-model <id> [--upstream-key-file <file>] [--upstream-window <tokens>] [--trace <folder>] …   a real model, seen through the counter
                                                                the key is read from the file into the environment, never shown or put on a command line
  navvied-eval run --agent <label|file> …                      another agent, described by a file of yours (docs/EVAL.md): it needs --upstream or --mock to be counted
  navvied-eval agents                                          the agent files found in your folder
  navvied-eval footprint [--cli "<command>"] [--install <path>] [--runs n]   size on disk and start time of a program
  navvied-eval report <results.jsonl>
`;

async function validate(tasks: Task[]): Promise<number> {
  let bad = 0;
  for (const task of tasks) {
    const v = await validateTask(task);
    process.stdout.write(`${v.status === "ok" ? "ok  " : v.status === "skipped" ? "skip" : "FAIL"} ${task.id}${v.problems.length ? `: ${v.problems.join("; ")}` : ""}\n`);
    if (v.status === "fail") bad += 1;
  }
  return bad ? 1 : 0;
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const only = option(rest, "tasks").flatMap((s) => s.split(",")).filter(Boolean);
  const chosen = (): Task[] => loadTasks(TASKS, only).filter((t) => only.length || rest.includes("--slow") || !t.slow);
  switch (command) {
    case "list": for (const t of loadTasks(TASKS)) process.stdout.write(`${t.id.padEnd(30)} ${t.kind.padEnd(9)} L${t.level} ${t.lang.padEnd(4)} ${t.title}${t.slow ? "  (slow)" : ""}\n`); return 0;
    case "validate": return validate(chosen());
    case "run": {
      const mockName = option(rest, "mock")[0], upstream = option(rest, "upstream")[0];
      const BEHAVIOURS = ["oracle", "code", "lazy", "tamper", "leave", "leak", "stall", "crash", "hang"];
      if (mockName && !BEHAVIOURS.includes(mockName)) { process.stderr.write(`error: --mock is one of ${BEHAVIOURS.join(", ")}\n`); return 2; }
      const agentName = option(rest, "agent")[0];
      let agent: Adapter | undefined;
      if (agentName) {
        const file = existsSync(agentName) ? agentName : join(agentsDir(process.env), `${agentName}.json`);
        try { agent = loadAdapter(file); } catch (e) { process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`); return 2; }
        if (!mockName && !upstream) { process.stderr.write("error: --agent needs --upstream (or --mock) so that the agent can be counted\n"); return 2; }
        if (!agent.pointable) process.stderr.write(`note: ${agent.label} has no {base_url} in its file, so its calls and tokens cannot be counted; its time, memory and result still are\n`);
      }
      const models = mockName || upstream ? [] : option(rest, "model");
      if (!models.length && !mockName && !upstream) { process.stderr.write(`error: give at least one --model, or --mock, or --upstream\n\n${USAGE}`); return 2; }
      if (upstream && !option(rest, "upstream-model")[0]) { process.stderr.write("error: --upstream needs --upstream-model\n"); return 2; }
      const repeat = Math.max(1, Number(option(rest, "repeat")[0] ?? 1) || 1);
      const out = option(rest, "out")[0];
      const cli = option(rest, "cli")[0];
      const command = cli ? cli.split(/\s+/) : ["bun", CLI];
      if (out) writeFileSync(out, "");
      // A scripted or counted model is reached by address, with a home of its own, so the person's own configuration is not used.
      let mock: Mock | undefined, meter: Meter | undefined, home: string | undefined;
      const label = agent ? `${agent.label}:${mockName ? `mock:${mockName}` : option(rest, "upstream-model")[0]}` : mockName ? `mock:${mockName}` : option(rest, "upstream-model")[0];
      const modelId = mockName ? "scripted" : option(rest, "upstream-model")[0];
      if (mockName || upstream) {
        mock = mockName ? startMock(loadTasks(TASKS), mockName as Behaviour) : undefined;
        meter = startMeter(mock?.url ?? upstream!);
        home = mkdtempSync(join(tmpdir(), "navvied-eval-home-"));
      }
      const keyFile = option(rest, "upstream-key-file")[0];
      const key = keyFile ? readFileSync(resolve(keyFile), "utf8").trim() : option(rest, "upstream-key")[0];
      const window = String(Number(option(rest, "upstream-window")[0] ?? 100000) || 100000);
      const world = home ? agentWorld(home, modelId!, Number(window), key) : {};
      if (home) codeTool(world, mockName === "code");
      const results: TaskResult[] = [];
      let broken = 0;
      try {
        for (const task of chosen()) {
          // A model that answers with a server error or not at all, twice in a row, is not asked again: that is for a person to look at.
          if (broken >= 2) { process.stderr.write("stopped: the model failed on two runs in a row (server errors or no answer); not asked again\n"); break; }
          for (const model of label && meter ? [label] : models) {
            for (let i = 0; i < repeat; i++) {
              const r = await runTask(task, { command, ...(meter ? { label: model, ...(agent ? { model: modelId! } : {}), env: world, meter, key: key ?? "none", ...(option(rest, "trace")[0] ? { trace: resolve(option(rest, "trace")[0]!) } : {}), ...(agent ? { agent } : { agentEnv: (base: string) => ({ NAVVIED_BASE_URL: base }) }) } : { model }) });
              results.push(r);
              broken = r.modelErrors || r.reason === "timeout" ? broken + 1 : 0;
              if (out) appendFileSync(out, `${JSON.stringify(r)}\n`);
              process.stderr.write(`${r.reason === "skipped" ? "skip" : r.passed ? "pass" : "FAIL"}  ${task.id}  ${model}  ${(r.ms / 1000).toFixed(1)}s  ${r.modelCalls} calls${r.passed ? "" : `  (${r.reason})`}\n`);
            }
          }
        }
      } finally { meter?.stop(); mock?.stop(); if (home) rmSync(home, { recursive: true, force: true }); }
      process.stdout.write(`\n${summarize(results)}\n`);
      return results.every((r) => r.passed || r.reason === "skipped") ? 0 : 1;
    }
    case "agents": {
      const dir = agentsDir(process.env);
      const found = listAdapters(dir);
      process.stdout.write(found.length ? `${found.map((a) => `${a.label.padEnd(24)} ${a.pointable ? "counted" : "not counted"}`).join("\n")}\n` : `No agent files in ${dir}.\n`);
      return 0;
    }
    case "footprint": {
      const cli = option(rest, "cli")[0];
      const command = cli ? cli.split(/\s+/) : ["bun", CLI];
      const f = await footprint([...command, "--version"], { ...(option(rest, "install")[0] ? { install: option(rest, "install")[0]! } : {}), runs: Number(option(rest, "runs")[0] ?? 5) || 5 });
      process.stdout.write(`${[
        `installed size   ${f.installBytes === undefined ? "not known: give --install <path>" : `${(f.installBytes / 1_048_576).toFixed(1)} MB`}`,
        `first start      ${f.firstMs} ms   (a home folder never used)`,
        `later starts     ${f.medianMs} ms   (the middle of ${f.runs - 1}, each with a new home folder)`,
      ].join("\n")}\n`);
      return 0;
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
