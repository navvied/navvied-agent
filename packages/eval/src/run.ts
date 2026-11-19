import { rmSync } from "node:fs";
import { LineSplitter, parseEvent } from "@navvied/protocol";
import type { Task } from "./task.ts";
import { check, prepare, protectedHashes } from "./workspace.ts";

export interface RunOptions {
  /** The program that runs a task, as an argument list (for example `["bun", "packages/cli/src/main.ts"]`). */
  command: string[];
  model?: string;
  env?: Record<string, string>;
  /** Keep the workspace afterwards (its path is in the result). */
  keep?: boolean;
}

export interface TaskResult {
  task: string;
  model: string;
  passed: boolean;
  reason: "solved" | "check failed" | "protected files changed" | "timeout" | "agent failed";
  ms: number;
  modelCalls: number;
  toolCalls: number;
  outTokens: number;
  peakContext: number;
  exitCode: number | null;
  error?: string;
  workspace?: string;
}

interface Metrics { modelCalls: number; toolCalls: number; outTokens: number; peakContext: number; error?: string }

function measure(stdout: string): Metrics {
  const m: Metrics = { modelCalls: 0, toolCalls: 0, outTokens: 0, peakContext: 0 };
  const seenTools = new Set<string>();
  for (const line of new LineSplitter().push(`${stdout}\n`)) {
    const parsed = parseEvent(line);
    if (!parsed.ok) continue;
    const e = parsed.value;
    if (e.ev === "usage") { m.modelCalls += 1; m.outTokens += e.out; m.peakContext = Math.max(m.peakContext, e.ctx); }
    else if (e.ev === "tool" && !e.parent && !seenTools.has(e.id)) { seenTools.add(e.id); m.toolCalls += 1; }
    else if (e.ev === "error" && !m.error) m.error = e.msg;
  }
  return m;
}

export async function runTask(task: Task, opts: RunOptions): Promise<TaskResult> {
  const dir = prepare(task);
  const before = protectedHashes(dir, task.protect);
  const started = Date.now();
  const [program, ...base] = opts.command;
  const proc = Bun.spawn(
    [program!, ...base, "run", task.prompt, "--cwd", dir, "--json", "--mode", "auto", "--max-steps", String(task.maxSteps), ...(opts.model ? ["--model", opts.model] : [])],
    { env: { ...process.env, ...opts.env }, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; proc.kill("SIGKILL"); }, task.timeoutSeconds * 1000);
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const exitCode = await proc.exited;
  clearTimeout(timer);

  const ms = Date.now() - started;
  const metrics = measure(stdout);
  const after = protectedHashes(dir, task.protect);
  const tampered = JSON.stringify(Object.entries(before).sort()) !== JSON.stringify(Object.entries(after).sort());
  const result = timedOut ? undefined : await check(dir, task);

  const reason: TaskResult["reason"] = timedOut ? "timeout" : tampered ? "protected files changed" : !result?.ok ? (exitCode !== 0 && exitCode !== null ? "agent failed" : "check failed") : "solved";
  const error = metrics.error ?? (reason === "agent failed" ? stderr.trim().split("\n").at(-1) : undefined);
  const out: TaskResult = {
    task: task.id, model: opts.model ?? "default", passed: reason === "solved", reason, ms,
    modelCalls: metrics.modelCalls, toolCalls: metrics.toolCalls, outTokens: metrics.outTokens, peakContext: metrics.peakContext, exitCode,
    ...(error ? { error: error.slice(0, 300) } : {}),
    ...(opts.keep ? { workspace: dir } : {}),
  };
  if (!opts.keep) rmSync(dir, { recursive: true, force: true });
  return out;
}
