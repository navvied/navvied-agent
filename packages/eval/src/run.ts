import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { gitEnv } from "../../engine/src/git-env.ts";
import { join } from "node:path";
import { LineSplitter, parseEvent, type PlanEntry } from "@navvied/protocol";
import type { Adapter } from "./adapter.ts";
import { instantiate } from "./adapter.ts";
import { watchMemory } from "./memory.ts";
import type { Meter } from "./meter.ts";
import type { Task } from "./task.ts";
import { FIXTURES, check, killProcesses, leftovers, missingPrograms, newSecret, prepare, protectedHashes, agentConfig, scriptEnv, shell, taskEnv, taskPrompt } from "./workspace.ts";

export interface RunOptions {
  /** The program that runs a task, as an argument list (for example `["bun", "packages/cli/src/main.ts"]`). */
  command: string[];
  model?: string;
  /** What the results call this agent and model, when `model` is not it (the scripted model, a real one seen through the counter). */
  label?: string;
  env?: Record<string, string>;
  /** Keep the workspace afterwards (its path is in the result). */
  keep?: boolean;
  /** The counter in front of the model, and the environment that points this agent at an address: calls, tokens and prompt weight are then counted by the counter. */
  meter?: Meter;
  agentEnv?: (baseUrl: string) => Record<string, string>;
  /** Another agent, described as data (see adapter.ts): started with its own command instead of ours. */
  agent?: Adapter;
  /** The key the agent is given for the counter, where it takes one. */
  key?: string;
  /** A folder to keep what the agent printed (its events) and what it said on its error output, one pair of files per run, for reading why a run went as it did. A key is cut out of it. */
  trace?: string;
}

/** How the agent misused the terminal: calls the tools refused as wrong, waits that only polled, and a `cd` put in front of a command that could have used `cwd`. */
export interface Misuse { badCalls: number; polls: number; cdCalls: number }

/** The tool that runs a script which calls other tools: the calls it makes are shown under its step. */
const CODE_TOOL = "ExecuteCode";
const TERMINAL_TOOLS = new Set(["Bash", "BashOutput", "BashInput", "KillShell"]);

/** From the steps of one run (each tool call as it ended), how the terminal was misused. */
export function misuseOf(steps: readonly { name: string; input?: unknown; output?: string; status: string }[]): Misuse {
  const m: Misuse = { badCalls: 0, polls: 0, cdCalls: 0 };
  for (const s of steps) {
    if (!TERMINAL_TOOLS.has(s.name)) continue;
    const input = (s.input && typeof s.input === "object" ? s.input : {}) as Record<string, unknown>;
    if (s.status === "error" && /^Error:/.test(s.output ?? "")) m.badCalls += 1;
    if (s.name === "BashOutput" && input.job_id && !input.wait && !input.until && /\(no new output\)/.test(s.output ?? "")) m.polls += 1;
    if (s.name === "Bash" && !input.cwd && typeof input.command === "string" && /^\s*cd\s+[^;&|]+(&&|;)/.test(input.command)) m.cdCalls += 1;
  }
  return m;
}

/** How the web tools were used: calls, characters of web text that entered the conversation, the same page read twice from the start, addresses fetched that nobody had given, and calls the tool refused as wrongly made. */
export interface WebUse { calls: number; chars: number; repeats: number; invented: number; badCalls: number }

const WEB_TOOLS = new Set(["WebFetch", "WebSearch", "Browser"]);
const key = (u: string): string => u.replace(/#.*$/, "").replace(/\/$/, "");

/** From the steps of one run, how the web was used. `known` is the text the agent started with (the task, the files it was told to read). */
export function webOf(steps: readonly { name: string; input?: unknown; output?: string; status: string }[], known: string): WebUse {
  const w: WebUse = { calls: 0, chars: 0, repeats: 0, invented: 0, badCalls: 0 };
  const seen = new Set((known.match(/https?:\/\/[^\s<>"')\]]+/g) ?? []).map(key));
  const read = new Set<string>();
  for (const s of steps) {
    if (!WEB_TOOLS.has(s.name)) continue;
    w.calls += 1;
    w.chars += s.output?.length ?? 0;
    const input = (s.input && typeof s.input === "object" ? s.input : {}) as Record<string, unknown>;
    if (s.status === "error" && /^Error: (.* needs |that is not a valid URL|the query is empty)/.test(s.output ?? "")) w.badCalls += 1;
    if (s.name === "WebFetch" && typeof input.url === "string") {
      const at = `${key(input.url)}@${typeof input.offset === "number" ? input.offset : 0}`;
      if (read.has(at)) w.repeats += 1;
      read.add(at);
      if (!seen.has(key(input.url))) w.invented += 1;
    }
    for (const u of s.output?.match(/https?:\/\/[^\s<>"')\]]+/g) ?? []) seen.add(key(u.replace(/[.,;:!?]+$/, "")));
  }
  return w;
}

/** Whether a task list was kept the way it should be: at least one list, one item in progress at most in each, and the last with everything done. Says what is wrong, or nothing. */
export function planKept(lists: readonly (readonly PlanEntry[])[]): string | undefined {
  if (!lists.length) return "no task list was kept";
  if (lists.some((l) => l.filter((e) => e.status === "in_progress").length > 1)) return "two items were in progress at once";
  return lists.at(-1)!.every((e) => e.status === "completed") ? undefined : "the last list still has unfinished items";
}

export interface TaskResult {
  task: string;
  /** What kind of work the task is, how hard, in which language (as the task says), for the report. */
  kind?: Task["kind"];
  level?: Task["level"];
  lang?: Task["lang"];
  model: string;
  passed: boolean;
  reason: "solved" | "check failed" | "protected files changed" | "timeout" | "agent failed" | "left a process running" | "setup failed" | "skipped" | "task list not kept";
  ms: number;
  modelCalls: number;
  toolCalls: number;
  outTokens: number;
  peakContext: number;
  exitCode: number | null;
  /** Counted by the counter (the calls, tokens in and out and prompt weight below), not reported by the agent. */
  inTokens?: number;
  /** Some answer carried no token counts, so some of the tokens are characters divided by four. */
  estimated?: boolean;
  /** Time the counter waited before passing requests on (to keep to the service's rate, to back off): not the model's or the agent's. */
  waitedMs?: number;
  /** From the start of the agent to its first request to the model. */
  firstRequestMs?: number;
  /** For a run that did not solve the task: what the agent last said, the steps it took, and the tail of what the check printed. */
  why?: { said: string; steps: string[]; check: string };
  /** When the time ran out: whether the check passed all the same (the task was done, the agent was still waiting for its last answer). */
  checkedAtTimeout?: boolean;
  /** How the agent misused the terminal tools (ours only: another agent is measured from outside). */
  misuse?: Misuse;
  /** How the agent used the web tools (ours only). */
  web?: WebUse;
  /** The calls the model made, by tool, and the calls scripts made from inside the code tool (shown under it, not counted in `toolCalls`). */
  tools?: Record<string, number>;
  nestedCalls?: number;
  /** How many requests the model answered with a server error or not at all. */
  modelErrors?: number;
  /** The biggest request of the run, whatever became of it (a request that was never answered is counted by its size, estimated): a run that stalls is often one whose request grew. */
  largest?: { requestBytes: number; inTokens: number; status: number };
  /** The first request: characters of the system prompt, tools offered, characters of their definitions, bytes sent. */
  prompt?: { systemChars: number; tools: number; toolChars: number; requestBytes: number };
  /** The highest memory of the agent alone and of the agent with everything it started (not measured on Windows). */
  peakMb?: number;
  peakTreeMb?: number;
  error?: string;
  workspace?: string;
}

interface Metrics { tools?: Record<string, number>; nested?: number; /** Every task list the agent sent. */ plans?: PlanEntry[][]; misuse?: Misuse; web?: WebUse; modelCalls: number; toolCalls: number; outTokens: number; peakContext: number; error?: string; /** What the agent said in its last turn. */ said?: string; /** The tools it used, in order, with how each ended. */ steps?: string[] }

function measure(stdout: string, known = ""): Metrics {
  const m: Metrics = { modelCalls: 0, toolCalls: 0, outTokens: 0, peakContext: 0 };
  const seenTools = new Set<string>(), seenNested = new Set<string>(), names = new Map<string, string>();
  const inputs = new Map<string, unknown>();
  const ended: { name: string; input?: unknown; output?: string; status: string }[] = [];
  for (const line of new LineSplitter().push(`${stdout}\n`)) {
    const parsed = parseEvent(line);
    if (!parsed.ok) continue;
    const e = parsed.value;
    if (e.ev === "usage") { m.modelCalls += 1; m.outTokens += e.out; m.peakContext = Math.max(m.peakContext, e.ctx); }
    else if (e.ev === "tool" && e.parent) { if (names.get(e.parent) === CODE_TOOL && !seenNested.has(e.id)) { seenNested.add(e.id); m.nested = (m.nested ?? 0) + 1; } }
    else if (e.ev === "tool") {
      if (!seenTools.has(e.id)) { seenTools.add(e.id); names.set(e.id, e.name); m.toolCalls += 1; m.tools = { ...m.tools, [e.name]: (m.tools?.[e.name] ?? 0) + 1 }; }
      if (e.input !== undefined) inputs.set(e.id, e.input);
      if (e.status !== "running") { (m.steps ??= []).push(`${e.name}:${e.status}`); ended.push({ name: e.name, status: e.status, input: inputs.get(e.id), ...(e.output !== undefined ? { output: e.output } : {}) }); }
    }
    else if (e.ev === "plan") (m.plans ??= []).push(e.entries);
    else if (e.ev === "error" && !m.error) m.error = e.msg;
    else if (e.ev === "text") m.said = `${m.said ?? ""}${e.text}`;
  }
  m.misuse = misuseOf(ended);
  if (ended.some((s) => WEB_TOOLS.has(s.name))) m.web = webOf(ended, known);
  return m;
}

const about = (t: Task): Pick<TaskResult, "kind" | "level" | "lang"> => ({ kind: t.kind, level: t.level, lang: t.lang });

export async function runTask(task: Task, opts: RunOptions): Promise<TaskResult> {
  const model = opts.label ?? opts.model ?? "default";
  const none = { modelCalls: 0, toolCalls: 0, outTokens: 0, peakContext: 0, exitCode: null, ms: 0 };
  const missing = missingPrograms(task);
  if (missing.length) return { ...about(task), task: task.id, model, passed: false, reason: "skipped", error: `needs ${missing.join(", ")}`, ...none };
  const secret = { BENCH_SECRET: newSecret() };
  const dir = prepare(task);
  if (task.setup) {
    const setup = await shell(dir, task.setup, scriptEnv(secret));
    if (!setup.ok) { killProcesses(leftovers(dir)); rmSync(dir, { recursive: true, force: true }); return { ...about(task), task: task.id, model, passed: false, reason: "setup failed", error: setup.output.trim().split("\n").at(-1)?.slice(0, 300) ?? "", ...none }; }
  }
  const before = protectedHashes(dir, task.protect);
  const config = agentConfig(task, dir);
  const prompt = taskPrompt(dir, task);
  const started = Date.now();
  const [program, ...base] = task.runner ? [process.execPath, join(FIXTURES, task.runner)] : opts.command;
  const runId = `${task.id}-${crypto.randomUUID().slice(0, 8)}`;
  const counted = opts.meter && opts.agentEnv ? opts.agentEnv(opts.meter.url(runId)) : {};
  // Another agent is started as its file says, in the workspace; ours is started with its own `run`.
  const other = opts.agent ? instantiate(opts.agent, { prompt, dir, ...(opts.model ? { model: opts.model } : {}), ...(opts.meter && opts.agent.pointable ? { baseUrl: opts.meter.url(runId) } : {}), ...(opts.key ? { key: opts.key } : {}) }) : undefined;
  const proc = Bun.spawn(
    other ? other.argv : [program!, ...base, "run", prompt, "--cwd", dir, "--json", "--mode", "auto", "--max-steps", String(task.maxSteps), ...(task.answers ? ["--answers", JSON.stringify(task.answers)] : []), ...(opts.model ? ["--model", opts.model] : [])],
    { cwd: dir, env: { ...gitEnv(), ...secret, NAVVIED_TERMINAL_ENV: "BENCH_SECRET", ...opts.env, ...config.env, ...taskEnv(dir, task), ...counted, ...other?.env }, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  const memory = watchMemory(proc.pid);
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; proc.kill("SIGKILL"); }, task.timeoutSeconds * 1000);
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const exitCode = await proc.exited;
  config.remove();
  if (opts.trace) {
    const hide = [opts.env?.NAVVIED_API_KEY, opts.key].filter((k): k is string => !!k && k.length >= 8 && k !== "none");
    const clean = (t: string): string => hide.reduce((x, k) => x.split(k).join("[key]"), t);
    mkdirSync(opts.trace, { recursive: true });
    writeFileSync(join(opts.trace, `${task.id}.events.jsonl`), clean(stdout));
    writeFileSync(join(opts.trace, `${task.id}.stderr.txt`), clean(stderr));
  }
  clearTimeout(timer);
  // What the agent printed is left in the workspace for the check: a task about a secret asserts that it is in no event.
  writeFileSync(join(dir, ".bench-events.jsonl"), stdout);
  const peak = memory.stop();
  const hits = opts.meter ? await opts.meter.take(runId) : [];

  const ms = Date.now() - started;
  // What an agent says about itself is read only for ours: another agent is measured from outside.
  const metrics = opts.agent ? { modelCalls: 0, toolCalls: 0, outTokens: 0, peakContext: 0 } as Metrics : measure(stdout, `${prompt}\n${["docs-url.txt", "addresses.txt"].map((f) => { try { return readFileSync(join(dir, f), "utf8"); } catch { return ""; } }).join("\n")}`);
  const after = protectedHashes(dir, task.protect);
  const tampered = JSON.stringify(Object.entries(before).sort()) !== JSON.stringify(Object.entries(after).sort());
  // The check is made also when time ran out: an agent that had done the task and was only waiting for its last answer is told apart.
  const result = await check(dir, task, 120_000, scriptEnv(secret));
  const left = leftovers(dir);
  killProcesses(left);
  if (task.teardown) await shell(dir, task.teardown, scriptEnv(secret)).catch(() => undefined);

  const reason: TaskResult["reason"] = timedOut ? "timeout" : tampered ? "protected files changed" : !result?.ok ? (exitCode !== 0 && exitCode !== null ? "agent failed" : "check failed") : left.length ? "left a process running" : task.plan && !opts.agent && planKept(metrics.plans ?? []) ? "task list not kept" : "solved";
  const error = metrics.error ?? (reason === "agent failed" ? stderr.trim().split("\n").at(-1) : reason === "task list not kept" ? planKept(metrics.plans ?? []) : undefined);
  // A secret the agent was given never reaches a result, whatever the agent or the model printed.
  const secrets = [opts.env?.NAVVIED_API_KEY, opts.key].filter((k): k is string => !!k && k.length >= 8 && k !== "none");
  const clean = (text: string): string => secrets.reduce((t, k) => t.split(k).join("[key]"), text);
  const out: TaskResult = {
    ...about(task), task: task.id, model, passed: reason === "solved", reason, ms,
    modelCalls: hits.length || metrics.modelCalls, toolCalls: metrics.toolCalls, outTokens: hits.length ? hits.reduce((n, h) => n + h.outTokens, 0) : metrics.outTokens, peakContext: metrics.peakContext, exitCode,
    ...(hits.length ? {
      modelErrors: hits.filter((h) => h.status >= 500).length, inTokens: hits.reduce((n, h) => n + h.inTokens, 0), estimated: hits.some((h) => h.estimated), firstRequestMs: Math.max(0, hits[0]!.at - started), waitedMs: hits.reduce((n, h) => n + h.waitedMs, 0),
      largest: ((big) => ({ requestBytes: big.requestBytes, inTokens: big.inTokens, status: big.status }))(hits.reduce((a, h) => (h.requestBytes > a.requestBytes ? h : a), hits[0]!)),
      prompt: { systemChars: hits[0]!.systemChars, tools: hits[0]!.tools, toolChars: hits[0]!.toolChars, requestBytes: hits[0]!.requestBytes },
    } : {}),
    ...(timedOut ? { checkedAtTimeout: result.ok } : {}),
    ...(metrics.tools ? { tools: metrics.tools } : {}),
    ...(metrics.nested ? { nestedCalls: metrics.nested } : {}),
    ...(metrics.misuse ? { misuse: metrics.misuse } : {}),
    ...(metrics.web ? { web: metrics.web } : {}),
    ...(peak ? { peakMb: peak.agentMb, peakTreeMb: peak.treeMb } : {}),
    ...(reason !== "solved" ? { why: { said: clean(metrics.said ?? "").slice(-300), steps: (metrics.steps ?? []).slice(0, 40), check: clean(result?.output ?? "").slice(-400) } } : {}),
    ...(error ? { error: clean(error).slice(0, 300) } : {}),
    ...(opts.keep ? { workspace: dir } : {}),
  };
  if (!opts.keep) rmSync(dir, { recursive: true, force: true });
  return out;
}
