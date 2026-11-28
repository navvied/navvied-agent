/**
 * Hooks: commands the person has chosen to run around what the agent does. They run with the person's own permissions, so
 * they come only from the person's own configuration or from a plugin the person switched on. A command gets a JSON description
 * of the event on standard input and answers in one of two ways:
 *  - by its exit code: 2 stops what is about to happen (before a tool and before a message) and what it wrote on standard error is told to the model;
 *  - by JSON on standard output (exit 0): `decision` (`block`, `ask`, `allow`), `reason`, `updatedInput`, `additionalContext`.
 * A hook can only lower what the mode allows (block, or ask the person). `allow` changes nothing: the mode and the rules still decide.
 */
import { ChildEnv, spawn } from "./process-start.ts";
import type { HookDecision } from "@navvied/protocol";
import { secretNames, type EnvPolicy } from "./child-env.ts";
import { killTree, shellFor, usesProcessGroups } from "./platform.ts";

export const HOOK_EVENTS = ["PreToolUse", "PostToolUse", "UserPromptSubmit", "Stop", "SessionStart", "SessionEnd", "PreCompact", "Notification"] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

export interface HookCommand {
  /** A pattern for the whole tool name (default and `*`: every tool). For `Notification` it is matched against the kind (`approval`, `question`). */
  matcher?: string;
  command: string;
  /** Seconds before the command is stopped (default 30, at most 600). */
  timeout?: number;
  /** Where the command comes from, shown with it wherever it is listed or reported (`plugin:name`); a command from the person's own configuration has none. */
  source?: string;
  /** The folder of the plugin the command came from, handed to it as `NAVVIED_PLUGIN_ROOT`. */
  root?: string;
}

export type HookConfig = Partial<Record<HookEvent, HookCommand[]>>;

/** What one hook decided, for the person to see which hook did what: the event it ran for, its command, where it comes from, and why in its own words. */
export interface HookSaid { event: HookEvent; decision: HookDecision; hook: string; source?: string; reason?: string }

/** What the hooks said about a tool that is about to run. */
export interface PreVerdict {
  /** What each hook decided. */
  said?: HookSaid[];
  /** A reason means: do not run it. */
  block?: string;
  /** A reason means: the person must say yes first, whatever the mode. */
  ask?: string;
  /** Replaces keys of the tool's input. The call is judged again with it, so a hook never gets a call past the mode. */
  updatedInput?: Record<string, unknown>;
  /** Text for the model, added to what the tool returns. */
  context?: string;
  notes: string[];
}

export interface Hooks {
  /** Before a tool runs. */
  pre(call: { tool: string; input: Record<string, unknown> }, signal: AbortSignal): Promise<PreVerdict>;
  /** After a tool ran: `context` is added to what the model reads. */
  post(call: { tool: string; input: Record<string, unknown>; output: string }, signal: AbortSignal): Promise<{ notes: string[]; context?: string; said?: HookSaid[] }>;
  /** After a turn. A reason asks the agent to go on once more, with it. `active` tells a hook that it already did so. */
  stop(info: { reason: string; active?: boolean }): Promise<{ notes: string[]; block?: string; said?: HookSaid[] }>;
  /** Before a message is taken (and, for the first of a session, before `SessionStart` too). A reason means: do not take it. What a command printed is added to the message as extra context. */
  prompt?(info: { text: string; first: boolean }, signal: AbortSignal): Promise<{ block?: string; context?: string; notes: string[]; said?: HookSaid[] }>;
  /** Before older turns are summarised. */
  compact?(info: { manual: boolean }, signal: AbortSignal): Promise<{ notes: string[] }>;
  /** The conversation is closing. */
  end?(info: { reason: string }): Promise<{ notes: string[] }>;
  /** The agent waits for the person: an approval or a question. */
  notify?(info: { kind: "approval" | "question"; message: string }): Promise<{ notes: string[] }>;
}

interface Outcome { code: number | null; stderr: string; stdout: string; timedOut: boolean }

const ANSWER_MAX = 100_000;
const CONTEXT_MAX = 8_000;
const TIMEOUT_MAX_S = 600;

function runCommand(hook: HookCommand, input: unknown, cwd: string, env: ChildEnv, signal: AbortSignal): Promise<Outcome> {
  const timeoutMs = Math.min(hook.timeout ?? 30, TIMEOUT_MAX_S) * 1000;
  return new Promise((done) => {
    const [cmd, ...args] = shellFor().argv(hook.command);
    let child;
    try { child = spawn(cmd!, args, { cwd, detached: usesProcessGroups(), windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: env.with({ NAVVIED_HOOK: "1", NAVVIED_PROJECT_DIR: cwd, ...(hook.root ? { NAVVIED_PLUGIN_ROOT: hook.root } : {}) }) }); }
    catch (e) { return done({ code: null, stderr: e instanceof Error ? e.message : String(e), stdout: "", timedOut: false }); }
    let stderr = "", stdout = "", timedOut = false, settled = false;
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      done({ code, stderr: stderr.trim().slice(0, 2000), stdout: stdout.trim(), timedOut });
    };
    const stop = (): void => killTree(child);
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    signal.addEventListener("abort", stop, { once: true });
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => { if (stdout.length < ANSWER_MAX) stdout += d; });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (d: string) => { stderr = (stderr + d).slice(-4000); });
    child.stdin?.on("error", () => undefined);
    child.on("error", (e) => { stderr += e.message; finish(null); });
    child.on("close", (code) => finish(code));
    try { child.stdin?.end(`${JSON.stringify(input)}\n`); } catch { /* the command did not want input */ }
  });
}

const matches = (hook: HookCommand, subject: string): boolean => {
  if (!hook.matcher || hook.matcher === "*") return true;
  try { return new RegExp(`^(?:${hook.matcher})$`).test(subject); } catch { return false; }
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** What a command's JSON answer says, in the shape used here. The answer of other agents' hooks (`hookSpecificOutput`, `approve`, `deny`) is understood too. */
export interface Answer { decision?: "block" | "ask" | "allow"; reason?: string; updatedInput?: Record<string, unknown>; context?: string }

export function parseAnswer(stdout: string): Answer | "not-json" | undefined {
  if (!stdout.startsWith("{")) return undefined;
  let raw: unknown;
  try { raw = JSON.parse(stdout); } catch { return "not-json"; }
  if (!isObject(raw)) return "not-json";
  const special = isObject(raw.hookSpecificOutput) ? raw.hookSpecificOutput : {};
  const word = String(raw.decision ?? special.permissionDecision ?? "").toLowerCase();
  const decision = word === "block" || word === "deny" ? "block" : word === "ask" ? "ask" : word === "allow" || word === "approve" ? "allow" : undefined;
  const reason = [raw.reason, special.permissionDecisionReason].find((v): v is string => typeof v === "string" && v.length > 0);
  const updated = [raw.updatedInput, special.updatedInput].find(isObject);
  const context = [raw.additionalContext, special.additionalContext].find((v): v is string => typeof v === "string" && v.length > 0);
  return { ...(decision ? { decision } : {}), ...(reason ? { reason: reason.slice(0, 2000) } : {}), ...(updated ? { updatedInput: updated } : {}), ...(context ? { context: context.slice(0, CONTEXT_MAX) } : {}) };
}

interface Run { block?: string; ask?: string; updatedInput?: Record<string, unknown>; context?: string; notes: string[]; said: HookSaid[] }

/**
 * Hooks that run the configured commands. A command that fails to run is reported as a note and never stops the agent. The commands
 * start with this program's environment less what the terminal also does not hand on (`env`, as for a command the model runs).
 */
export function commandHooks(config: HookConfig, cwd: string, session: () => string, env: EnvPolicy = { drop: secretNames() }): Hooks {
  const run = async (event: HookEvent, subject: string | undefined, rest: Record<string, unknown>, signal: AbortSignal): Promise<Run> => {
    const notes: string[] = [];
    const said: HookSaid[] = [];
    const context: string[] = [];
    let ask: string | undefined, updatedInput: Record<string, unknown> | undefined;
    const base = ChildEnv.scrubbed(process.env, env);
    const toolInput = (): Record<string, unknown> | undefined => (isObject(rest.input) ? { ...rest.input, ...updatedInput } : undefined);
    for (const hook of config[event] ?? []) {
      if (subject !== undefined && !matches(hook, subject)) continue;
      const input = toolInput();
      const payload = { event, cwd, session: session(), hook_event_name: event, session_id: session(), ...rest, ...(input ? { input, tool_input: input } : {}), ...(typeof rest.tool === "string" ? { tool_name: rest.tool } : {}), ...(typeof rest.output === "string" ? { tool_response: rest.output } : {}) };
      const outcome = await runCommand(hook, payload, cwd, base, signal);
      const say = (decision: HookDecision, reason?: string): void => { said.push({ event, decision, hook: hook.command, ...(hook.source ? { source: hook.source } : {}), ...(reason ? { reason: reason.slice(0, 300) } : {}) }); };
      const label = `The ${event} hook "${hook.command}"${hook.source ? ` (from ${hook.source})` : ""}`;
      if (outcome.timedOut) { notes.push(`${label} took longer than ${hook.timeout ?? 30} s and was stopped.`); continue; }
      if (outcome.code === 2) {
        const reason = outcome.stderr || "a hook said no";
        if (event === "PreToolUse" || event === "UserPromptSubmit" || event === "Stop") { say("blocked", reason); return { block: reason, notes, said, ...(updatedInput ? { updatedInput } : {}) }; }
        if (event === "PostToolUse" && outcome.stderr) { context.push(outcome.stderr); say("added", outcome.stderr); }
        continue;
      }
      if (outcome.code !== 0) {
        notes.push(`${label} failed${outcome.code !== null ? ` (exit ${outcome.code})` : ""}${outcome.stderr ? `: ${outcome.stderr.split("\n")[0]}` : ""}.`);
        continue;
      }
      const answer = parseAnswer(outcome.stdout);
      if (answer === "not-json") { notes.push(`${label} printed something that is not valid JSON, so it was ignored.`); continue; }
      if (!answer) {
        if (outcome.stdout && (event === "UserPromptSubmit" || event === "SessionStart")) context.push(outcome.stdout.slice(0, CONTEXT_MAX));
        continue;
      }
      if (answer.context) { context.push(answer.context); say("added", answer.context); }
      if (answer.decision === "block" && event !== "SessionStart" && event !== "SessionEnd" && event !== "PreCompact" && event !== "Notification") {
        const reason = answer.reason || "a hook said no";
        // After a tool ran there is nothing left to stop: the reason goes to the model.
        if (event === "PostToolUse") { context.push(reason); say("added", reason); }
        else { say("blocked", reason); return { block: reason, notes, said, ...(updatedInput ? { updatedInput } : {}), ...(context.length ? { context: context.join("\n") } : {}) }; }
      }
      if (answer.decision === "allow") say("allowed", answer.reason);
      if (answer.decision === "ask" && event === "PreToolUse") { ask ??= answer.reason || `the ${event} hook "${hook.command}" asks first`; say("asked", answer.reason); }
      if (answer.updatedInput && event === "PreToolUse") { updatedInput = { ...updatedInput, ...answer.updatedInput }; say("changed", answer.reason); }
    }
    return { notes, said, ...(ask ? { ask } : {}), ...(updatedInput ? { updatedInput } : {}), ...(context.length ? { context: context.join("\n") } : {}) };
  };
  const forever = new AbortController().signal;
  const told = (said: HookSaid[]): { said?: HookSaid[] } => (said.length ? { said } : {});
  return {
    pre: async (call, signal) => { const { said, ...r } = await run("PreToolUse", call.tool, { tool: call.tool, input: call.input }, signal); return { ...r, ...told(said) }; },
    post: async (call, signal) => { const r = await run("PostToolUse", call.tool, { tool: call.tool, input: call.input, output: call.output.slice(0, 20_000) }, signal); return { notes: r.notes, ...told(r.said), ...(r.context ? { context: r.context } : {}) }; },
    prompt: async (info, signal) => {
      const start = info.first ? await run("SessionStart", undefined, {}, signal) : undefined;
      const submit = await run("UserPromptSubmit", undefined, { prompt: info.text.slice(0, 20_000) }, signal);
      const context = [start?.context, submit.context].filter(Boolean).join("\n");
      return { notes: [...(start?.notes ?? []), ...submit.notes], ...told([...(start?.said ?? []), ...submit.said]), ...(submit.block ? { block: submit.block } : {}), ...(context ? { context } : {}) };
    },
    compact: async (info, signal) => ({ notes: (await run("PreCompact", undefined, { manual: info.manual }, signal)).notes }),
    stop: async (info) => { const r = await run("Stop", undefined, { reason: info.reason, stop_hook_active: info.active === true }, forever); return { notes: r.notes, ...told(r.said), ...(r.block ? { block: r.block } : {}) }; },
    end: async (info) => ({ notes: (await run("SessionEnd", undefined, { reason: info.reason }, forever)).notes }),
    notify: async (info) => ({ notes: (await run("Notification", info.kind, { kind: info.kind, message: info.message.slice(0, 2000) }, forever)).notes }),
  };
}
