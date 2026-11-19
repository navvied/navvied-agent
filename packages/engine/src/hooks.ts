/**
 * Hooks: commands the person has chosen to run around what the agent does. They run with the person's own permissions, so
 * they come only from the person's own configuration. A command gets a JSON description of the event on standard input.
 * Before a tool runs, a command that ends with code 2 stops it, and what it wrote on standard error is told to the model.
 */
import { spawn } from "node:child_process";
import { killTree, shellFor, usesProcessGroups } from "./platform.ts";

export type HookEvent = "PreToolUse" | "PostToolUse" | "Stop" | "UserPromptSubmit" | "SessionStart" | "PreCompact";

export interface HookCommand {
  /** A pattern for the tool name (default: every tool). Only for the two tool events. */
  matcher?: string;
  command: string;
  /** Seconds before the command is stopped (default 30). */
  timeout?: number;
}

export type HookConfig = Partial<Record<HookEvent, HookCommand[]>>;

export interface Hooks {
  /** Before a tool runs. A reason means: do not run it. */
  pre(call: { tool: string; input: Record<string, unknown> }, signal: AbortSignal): Promise<{ block?: string; notes: string[] }>;
  post(call: { tool: string; input: Record<string, unknown>; output: string }, signal: AbortSignal): Promise<{ notes: string[] }>;
  stop(info: { reason: string }): Promise<{ notes: string[] }>;
  /** Before a message is taken (and, for the first of a session, before `SessionStart` too). A reason means: do not take it. What a command printed is added to the message as extra context. */
  prompt?(info: { text: string; first: boolean }, signal: AbortSignal): Promise<{ block?: string; context?: string; notes: string[] }>;
  /** Before older turns are summarised. */
  compact?(info: { manual: boolean }, signal: AbortSignal): Promise<{ notes: string[] }>;
}

interface Outcome { code: number | null; stderr: string; stdout: string; timedOut: boolean }

function runCommand(command: string, input: unknown, cwd: string, timeoutMs: number, signal: AbortSignal): Promise<Outcome> {
  return new Promise((done) => {
    const [cmd, ...args] = shellFor().argv(command);
    let child;
    try { child = spawn(cmd!, args, { cwd, detached: usesProcessGroups(), windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, NAVVIED_HOOK: "1" } }); }
    catch (e) { return done({ code: null, stderr: e instanceof Error ? e.message : String(e), stdout: "", timedOut: false }); }
    let stderr = "", stdout = "", timedOut = false, settled = false;
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      done({ code, stderr: stderr.trim().slice(0, 2000), stdout: stdout.trim().slice(0, 2000), timedOut });
    };
    const stop = (): void => killTree(child);
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    signal.addEventListener("abort", stop, { once: true });
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => { stdout = (stdout + d).slice(0, 4000); });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (d: string) => { stderr = (stderr + d).slice(-4000); });
    child.stdin?.on("error", () => undefined);
    child.on("error", (e) => { stderr += e.message; finish(null); });
    child.on("close", (code) => finish(code));
    try { child.stdin?.end(`${JSON.stringify(input)}\n`); } catch { /* the command did not want input */ }
  });
}

const matches = (hook: HookCommand, tool: string): boolean => {
  if (!hook.matcher) return true;
  try { return new RegExp(`^(?:${hook.matcher})$`).test(tool); } catch { return false; }
};

/** Hooks that run the configured commands. A command that fails to run is reported as a note and never stops the agent. */
export function commandHooks(config: HookConfig, cwd: string, session: () => string): Hooks {
  const payload = (event: HookEvent, rest: Record<string, unknown>) => ({ event, cwd, session: session(), ...rest });
  const run = async (event: HookEvent, tool: string | undefined, rest: Record<string, unknown>, signal: AbortSignal): Promise<{ block?: string; notes: string[]; said?: string }> => {
    const notes: string[] = [];
    const said: string[] = [];
    for (const hook of config[event] ?? []) {
      if (tool !== undefined && !matches(hook, tool)) continue;
      const outcome = await runCommand(hook.command, payload(event, rest), cwd, (hook.timeout ?? 30) * 1000, signal);
      if (outcome.code === 0 && outcome.stdout && (event === "UserPromptSubmit" || event === "SessionStart")) said.push(outcome.stdout);
      if (outcome.code === 2 && (event === "PreToolUse" || event === "UserPromptSubmit")) return { block: outcome.stderr || "a hook said no", notes };
      if (outcome.timedOut) notes.push(`The ${event} hook "${hook.command}" took longer than ${hook.timeout ?? 30} s and was stopped.`);
      else if (outcome.code !== 0) notes.push(`The ${event} hook "${hook.command}" failed${outcome.code !== null ? ` (exit ${outcome.code})` : ""}${outcome.stderr ? `: ${outcome.stderr.split("\n")[0]}` : ""}.`);
    }
    return { notes, ...(said.length ? { said: said.join("\n") } : {}) };
  };
  return {
    pre: (call, signal) => run("PreToolUse", call.tool, { tool: call.tool, input: call.input }, signal),
    post: async (call, signal) => ({ notes: (await run("PostToolUse", call.tool, { tool: call.tool, input: call.input, output: call.output.slice(0, 20_000) }, signal)).notes }),
    prompt: async (info, signal) => {
      const start = info.first ? await run("SessionStart", undefined, {}, signal) : undefined;
      const submit = await run("UserPromptSubmit", undefined, { prompt: info.text.slice(0, 20_000) }, signal);
      const context = [start?.said, submit.said].filter(Boolean).join("\n");
      return { notes: [...(start?.notes ?? []), ...submit.notes], ...(submit.block ? { block: submit.block } : {}), ...(context ? { context } : {}) };
    },
    compact: async (info, signal) => ({ notes: (await run("PreCompact", undefined, { manual: info.manual }, signal)).notes }),
    stop: async (info) => ({ notes: (await run("Stop", undefined, { reason: info.reason }, new AbortController().signal)).notes }),
  };
}
