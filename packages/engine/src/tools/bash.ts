import { localBackend } from "../backend.ts";
import { inTerminal, shellFor } from "../platform.ts";
import type { Tool } from "../types.ts";
import { MAX_OUTPUT, cleanOutput, clip, num, run, spill, str } from "./util.ts";

const shell = shellFor();

/** Programs whose exit code 1 is an answer, not a failure: said in words, so a model does not take "no matches" for a broken command. */
const ANSWERS: [RegExp, string][] = [[/^(grep|egrep|fgrep|rg|ag)$/, "no matches"], [/^(diff|cmp)$/, "the files differ"], [/^(test|\[)$/, "the condition is false"]];
function exitNote(command: string, code: number | null): string {
  if (code !== 1) return "";
  const last = command.split(/&&|\|\||;|\|/).pop()?.trim().split(/\s+/).find((w) => !/^\w+=/.test(w) && w !== "sudo" && w !== "env") ?? "";
  const hit = ANSWERS.find(([re]) => re.test(last.replace(/^.*\//, "")));
  return hit ? `: ${hit[1]}, not a failure` : "";
}

export const bash: Tool = {
  name: "Bash",
  readOnly: false,
  description: `Run a ${shell.name} command in the working directory. Output is shortened if long. Default timeout 120 s, maximum 600 s. For a server or a watcher that must keep running, set run_in_background and read it later with BashOutput. Every call starts a fresh shell: cd and variables do not carry over, and nothing can be typed to a command, so never wait for input.`,
  parameters: {
    type: "object",
    properties: {
      command: { type: "string" },
      timeout: { type: "number", description: "seconds" },
      description: { type: "string", description: "what the command does, in a few words" },
      run_in_background: { type: "boolean", description: "keep it running after this step; read it with BashOutput, stop it with KillShell" },
      interactive: { type: "boolean", description: "for a program you must type to (a REPL, an installer with questions): it runs in the background in a terminal, and you type with BashInput" },
    },
    required: ["command"],
  },
  title: (a) => `Run command: ${str(a.command).slice(0, 300)}`,
  async run(a, ctx) {
    const command = str(a.command);
    if (!command.trim()) return "Error: empty command.";
    let where: ReturnType<typeof localBackend.prepare>;
    try { where = (ctx.backend ?? localBackend).prepare(command, ctx.cwd); } catch (e) { return `Error: ${e instanceof Error ? e.message : String(e)}`; }
    if (a.interactive === true) {
      if (ctx.backend && ctx.backend.id !== "local") return "Error: a program you type to runs on this computer only, and commands are set to run elsewhere.";
      const job = ctx.jobs.start(inTerminal(where.argv) ?? where.argv, where.cwd, str(a.description) || command.slice(0, 80), undefined, true);
      ctx.report?.({ background: true });
      return `Started ${job.id}, a program you can type to. See what it prints with BashOutput (job_id "${job.id}", wait 2), type to it with BashInput, stop it with KillShell.`;
    }
    if (a.run_in_background === true) {
      const job = ctx.jobs.start(where.argv, where.cwd, str(a.description) || command.slice(0, 80));
      ctx.report?.({ background: true });
      return `Started ${job.id} in the background. Read what it prints with BashOutput (job_id "${job.id}"), stop it with KillShell.`;
    }
    const seconds = Math.min(Math.max(1, num(a.timeout, 120)), 600);
    const r = await run(where.argv, { cwd: where.cwd, signal: ctx.signal, timeoutMs: seconds * 1000, ...(ctx.live ? { onChunk: ctx.live } : {}) });
    ctx.report?.({ code: r.code, truncated: r.output.trimEnd().length > MAX_OUTPUT, timedOut: r.timedOut });
    const full = cleanOutput(r.output).trimEnd();
    // Whole output kept in a file (not in a conversation held to a folder, which may not read outside it).
    const saved = full.length > MAX_OUTPUT && !ctx.root ? spill(full) : undefined;
    const body = clip(full) + (saved ? `\n[the whole output is saved in ${saved}: read the part you need with Read]` : "");
    if (r.interrupted) return `${body}\n[interrupted]`;
    if (r.timedOut) return `${body}\n[timed out after ${seconds}s and was killed]`;
    return `${body}${body ? "\n" : ""}[exit ${r.code}${exitNote(command, r.code)}]`;
  },
};

const unknownJob = (id: string, jobs: { list(): { id: string }[] }): string => `Error: there is no job "${id}". ${jobs.list().length ? `Jobs: ${jobs.list().map((j) => j.id).join(", ")}.` : "No command is running in the background."}`;

export const bashOutput: Tool = {
  name: "BashOutput",
  readOnly: true,
  description: "Read what a background command has printed since you last read it, and whether it is still running. Set wait (seconds, at most 120) to wait until it prints something new or ends, instead of asking again and again.",
  parameters: { type: "object", properties: { job_id: { type: "string" }, wait: { type: "number", description: "seconds to wait for new output or the end" } }, required: ["job_id"] },
  offeredWhen: ({ jobs }) => jobs > 0,
  title: (a) => `Read output of ${str(a.job_id)}`,
  async run(a, ctx) {
    const id = str(a.job_id);
    const wait = Math.min(Math.max(0, num(a.wait, 0)), 120);
    if (wait > 0) await ctx.jobs.waitFor(id, wait * 1000, ctx.signal);
    const r = ctx.jobs.read(id);
    if (!r) return unknownJob(id, ctx.jobs);
    const state = r.view.status === "running" ? "still running" : `${r.view.status}${r.view.code !== null ? `, exit ${r.view.code}` : ""}`;
    const body = clip(cleanOutput(r.output).trimEnd());
    return `${r.skipped ? `[${r.skipped} earlier characters were dropped]\n` : ""}${body || "(no new output)"}\n[${r.view.id}: ${state}]`;
  },
};

export const bashInput: Tool = {
  name: "BashInput",
  readOnly: false,
  description: "Type to a program started with Bash interactive:true. The text is sent as typed, followed by Enter unless enter is false. Then read the reply with BashOutput (wait 2). Set end to finish the input, as Ctrl-D does.",
  parameters: { type: "object", properties: { job_id: { type: "string" }, text: { type: "string" }, enter: { type: "boolean", description: "press Enter after the text (default true)" }, end: { type: "boolean", description: "end the input (Ctrl-D) after the text" } }, required: ["job_id"] },
  offeredWhen: ({ typable }) => (typable ?? 0) > 0,
  title: (a) => `Type to ${str(a.job_id)}: ${str(a.text).slice(0, 200)}`,
  async run(a, ctx) {
    const id = str(a.job_id), text = str(a.text);
    if (!ctx.jobs.list().some((j) => j.id === id)) return unknownJob(id, ctx.jobs);
    if (text && !ctx.jobs.type(id, a.enter === false ? text : `${text}\n`)) return `Error: ${id} cannot be typed to: it ended, or it was not started with interactive:true.`;
    if (a.end === true && !ctx.jobs.endInput(id)) return `Error: the input of ${id} could not be ended.`;
    return `Typed to ${id}. Read what it printed with BashOutput (job_id "${id}", wait 2).`;
  },
};

export const killShell: Tool = {
  name: "KillShell",
  readOnly: false,
  description: "Stop a background command and everything it started.",
  parameters: { type: "object", properties: { job_id: { type: "string" } }, required: ["job_id"] },
  offeredWhen: ({ jobs }) => jobs > 0,
  title: (a) => `Stop ${str(a.job_id)}`,
  async run(a, ctx) {
    const id = str(a.job_id), v = ctx.jobs.stop(id);
    return v ? `${v.id} is ${v.status === "running" ? "stopping" : v.status}.` : unknownJob(id, ctx.jobs);
  },
};
