import type { Launch } from "../sandbox/index.ts";
import { existsSync, readFileSync } from "node:fs";
import { wrote } from "./file-state.ts";
import { printedFiles } from "./shell-reads.ts";
import { localBackend } from "../backend.ts";
import { shellFor } from "../platform.ts";
import type { Jobs } from "../jobs.ts";
import type { Tool, ToolContext } from "../types.ts";
import { relative, resolve } from "node:path";
import { redact } from "../redact.ts";
import { endedIn, inside, realPath, remembering, type ShellState } from "./shell-state.ts";
import { exitNote, maskedNote } from "./shell-notes.ts";
import { cleanOutput, clip, num, outputBudget, place, run, spill, str } from "./util.ts";

const shell = shellFor();
/** Where the script travels to the shell, and what the shell runs: it reads the script from the variable and drops it, so no command line of the machine holds the script's text. */
const SCRIPT_VAR = "NAVVIED_SCRIPT";
const SCRIPT_RUNNER = `__nv_s=$${SCRIPT_VAR}; unset ${SCRIPT_VAR}; eval "$__nv_s"`;
/** Bash can write down where a command ended and what it exported; PowerShell and cmd cannot, so there each call starts fresh. */
const remembers = shell.name === "bash";

/** How long a command may be silent before it goes on as a job. A model that started a server in the foreground gets control back after this, so it is short. */
const SILENCE_SECONDS = 45;

export const bash: Tool = {
  name: "Bash",
  readOnly: false,
  description: `Run a ${shell.name} command.${remembers ? " cd (inside the project) and export last across calls." : " Each call starts fresh."} One silent for its timeout goes on as a job.`,
  parameters: {
    type: "object",
    properties: {
      command: { type: "string" },
      cwd: { type: "string" },
      description: { type: "string" },
      timeout: { type: "number", description: "seconds without output, 45 if not given" },
      run_in_background: { type: "boolean", description: "keep it running as a job" },
      notify: { type: "string", description: "text that wakes me, or off" },
      interactive: { type: "boolean", description: "type to it with BashInput" },
    },
    required: ["command"],
  },
  title: (a) => `Run command: ${str(a.command).slice(0, 300)}`,
  run: runOne,
};

async function runOne(a: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  {
    const command = str(a.command);
    if (!command.trim()) return `Error: empty command, nothing was run. Retry: ${example({ command: "ls -la" })}`;
    let where: ReturnType<typeof localBackend.prepare>;
    // On this computer, in bash, a command starts from what earlier ones exported and from the folder they ended in (inside the working
    // folder). With `cwd` it runs there for this call and leaves the remembered folder as it was.
    const keep = remembers && ctx.shell && (!ctx.backend || ctx.backend.id === "local") ? ctx.shell : undefined;
    const explicit = a.cwd !== undefined && a.cwd !== "";
    try {
      let start = ctx.cwd;
      if (explicit) { start = place(ctx, a.cwd); if (start !== ctx.cwd && !existsSync(start)) return `Error: the folder ${start} does not exist, so nothing was run. Retry without cwd: ${example({ command })}`; }
      else if (keep?.dir) { if (existsSync(keep.dir)) start = keep.dir; else keep.dir = undefined; }
      where = (ctx.backend ?? localBackend).prepare(command, start, ctx.cwd);
    } catch (e) { return `Error: ${e instanceof Error ? e.message : String(e)}`; }
    // On this computer a command is confined unless the person turned that off or allowed this one outside; what really was done is said at the end of the result.
    let launch: Launch = { confined: false };
    // The script is not part of the shell's own command line: `pkill -f name` and `pgrep -f name` read every command line, and the script's own text holds the name.
    const hidden = remembers && (!ctx.backend || ctx.backend.id === "local");
    const script = (capture: boolean): string => (keep ? remembering(command, keep, capture) : command);
    let given = command;
    const argv = (capture: boolean): string[] => {
      given = script(capture);
      const plain = hidden ? [...where.argv.slice(0, -1), SCRIPT_RUNNER] : keep ? [...where.argv.slice(0, -1), given] : where.argv;
      if (!ctx.sandbox || ctx.unconfined || (ctx.backend && ctx.backend.id !== "local")) return plain;
      launch = ctx.sandbox.confine(plain, { root: ctx.cwd, cwd: where.cwd, detached: a.run_in_background === true });
      return launch.confined ? launch.argv : plain;
    };
    const scriptEnv = (): NodeJS.ProcessEnv | undefined => (hidden ? { [SCRIPT_VAR]: given } : undefined);
    const current = (): Launch => launch;
    const guarded = (): boolean => { const l = current(); return l.confined && l.guarded; };
    const withLine = (text: string): string => { const l = current().line; return l ? `${text}\n${l}` : text; };
    if (a.interactive === true || a.run_in_background === true) { const full = ctx.jobs.room(); if (full) return full; }
    if (a.interactive === true) {
      if (ctx.backend && ctx.backend.id !== "local") return `Error: a program you type to runs on this computer only, and commands are set to run elsewhere. Retry without interactive: ${example({ command })}`;
      const job = ctx.jobs.start(argv(false), where.cwd, str(a.description) || command.slice(0, 80), scriptEnv(), true, undefined, guarded());
      ctx.report?.({ background: true });
      return withLine(`Started ${job.id}, a program you can type to. See what it prints with BashOutput (job_id "${job.id}", wait 2), type to it with BashInput, stop it with KillShell.`);
    }
    if (a.run_in_background === true) {
      const notify = str(a.notify).trim();
      const job = ctx.jobs.start(argv(false), where.cwd, str(a.description) || command.slice(0, 80), scriptEnv(), false, notify || undefined);
      ctx.report?.({ background: true });
      const read = `BashOutput (job_id "${job.id}") reads what it prints, and KillShell stops it.`;
      const wake = !ctx.jobs.wakes ? `Read what it prints with BashOutput (job_id "${job.id}"), stop it with KillShell.` : notify === "off" ? `It will not wake you. ${read}` : `You are woken when it ends${notify ? ` or prints a line with "${notify.slice(0, 60)}"` : ""}: do other work or answer, do not poll. ${read}`;
      return withLine(`Started ${job.id} in the background. ${wake}`);
    }
    // `timeout` is how long the command may be silent; a command that goes on printing is working. Whatever it does, 10 minutes is the most
    // it holds this turn. Past either it is not killed: it goes on as a job, and what it printed so far is not lost.
    const seconds = Math.min(Math.max(1, num(a.timeout, SILENCE_SECONDS)), 600);
    let handedOn: string | undefined;
    const title = str(a.description) || command.slice(0, 80);
    const r = await run(argv(keep !== undefined && !explicit), { cwd: where.cwd, signal: ctx.signal, idleMs: seconds * 1000, timeoutMs: 600_000, guarded: guarded(), onSpawn: (child) => { if (current().confined) child.once("exit", ctx.jobs.track(child.pid)); }, ...(hidden || ctx.env ? { env: { ...(ctx.env ?? process.env), ...scriptEnv() } } : {}), ...(ctx.live ? { onChunk: ctx.live } : {}), onTimeout: (child, printed) => { handedOn = ctx.jobs.adopt(child, title, printed).id; return true; }, onLeft: (child, code, printed) => { handedOn = ctx.jobs.adoptLeft(child, code, title, printed).id; return true; } });
    const budget = outputBudget(ctx.window);
    const cleaned = cleanOutput(r.output);
    const full = redact(cleaned).trimEnd();
    // A command that only prints a file, whole and unaltered, is a read of it: the edit guard needs no second Read.
    if (r.code === 0 && !r.adopted && !r.interrupted && !r.timedOut && full.length <= budget && !r.file && full === cleaned.trimEnd() && (!ctx.backend || ctx.backend.id === "local")) {
      for (const f of printedFiles(command, where.cwd)) { try { place(ctx, f); wrote(ctx, f, readFileSync(f)); } catch { /* outside the folder this conversation may use, or gone: not a read */ } }
    }
    ctx.report?.({ code: r.code, truncated: full.length > budget, timedOut: r.timedOut && !r.adopted, ...(r.adopted ? { background: true } : {}) });
    // Whole output kept in a file (not in a conversation held to a folder, which may not read outside it). The end matters most: it gets the larger share.
    const saved = ctx.root ? undefined : r.file ?? (full.length > budget ? spill(full) : undefined);
    const body = clip(full, budget, 0.3) + (saved ? `\n[the whole output is saved in ${saved}: read the part you need with Read]` : "");
    if (r.interrupted) return `${body}\n[interrupted]`;
    if (r.adopted && handedOn && r.ranOut === "left") return withLine([body, r.code === 0 ? "" : `[exit ${r.code}]`, `[what the command started with & still runs as ${handedOn}: BashOutput job_id "${handedOn}" shows what it prints, KillShell stops it]`].filter(Boolean).join("\n"));
    if (r.adopted && handedOn) return withLine(`${body}${body ? "\n" : ""}[still running as ${handedOn} after ${r.ranOut === "time" ? "10 minutes" : `${seconds}s without output`}: BashOutput job_id "${handedOn}" shows what it prints next (until:"text" waits for a line), KillShell stops it]`);
    const ran = current();
    const denied = ran.confined && r.code !== 0 ? ran.denial(full, where.cwd) : undefined;
    if (denied) ctx.report?.({ denied });
    // An exit of 0 is not said: it is what no news means. Another code is, with what it means for the programs where it means something.
    const said = r.code === 0 ? maskedNote(command, r.code, full) : `[${r.code === null && r.signal ? r.signal : `exit ${r.code}`}${exitNote(command, r.code, full, r.signal)}]`;
    const moved = keep && !explicit ? whereNow(keep, ctx.cwd) : "";
    const lines = [body, moved, said, current().line].filter(Boolean);
    return lines.length ? lines.join("\n") : "(no output)";
  }
}

/** Where the next command starts, said only when the remembered folder changed; a folder outside the working folder is not kept. It says that navvied wrote it: a model took the bare note for output of the user's shell. */
function whereNow(state: ShellState, working: string): string {
  const end = endedIn(state);
  if (!end) return "";
  const top = realPath(working), now = realPath(end), before = realPath(state.dir ?? working);
  if (!inside(top, now)) return `[navvied: next commands still start in ${relative(top, before) || "the working folder"}, a cd outside the project lasts one command]`;
  if (now === before) return "";
  state.dir = now === top ? undefined : end;
  return `[navvied: next commands start in ${relative(top, now) || "the working folder"}]`;
}

/** A call as the model writes it, for a message that shows what to send instead. */
const example = (args: Record<string, unknown>): string => JSON.stringify({ ...args, ...(typeof args.command === "string" && args.command.length > 80 ? { command: `${args.command.slice(0, 77)}...` } : {}) });

const unknownJob = (id: string, jobs: { list(): { id: string }[] }): string => {
  const all = jobs.list();
  return `Error: there is no job "${id}". ${all.length ? `Jobs: ${all.map((j) => j.id).join(", ")}. Retry: ${example({ job_id: all[all.length - 1]!.id })}` : `No command is running in the background. To start one: Bash ${example({ command: "npm run dev", run_in_background: true })}`}`;
};

const age = (ms: number): string => (ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))} s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 3_600_000)} h`);

/** How long a job has run is read on the clock its start was written with, never on another one. */
function listJobs(jobs: Jobs): string {
  const all = jobs.list();
  if (!all.length) return "No command is running in the background.";
  return all.map((j) => `${j.id} ${j.status === "running" ? `running ${age(jobs.now() - j.startedAt)}` : `${j.status}${j.code !== null ? `, exit ${j.code}` : ""}`}: ${j.title}`).join("\n");
}

export const bashOutput: Tool = {
  name: "BashOutput",
  readOnly: true,
  description: "Read what a background command has printed since you last read it, and whether it is still running. Set wait (seconds, at most 120) to wait until it prints something new or ends, instead of asking again and again. Without job_id it lists the jobs.",
  parameters: { type: "object", properties: { job_id: { type: "string" }, wait: { type: "number", description: "seconds to wait for new output or the end" }, until: { type: "string", description: "wait until this text has appeared" } } },
  offeredWhen: ({ jobs }) => jobs > 0,
  title: (a) => `Read output of ${str(a.job_id)}`,
  async run(a, ctx) {
    const id = str(a.job_id);
    if (!id) return listJobs(ctx.jobs);
    const wait = Math.min(Math.max(0, num(a.wait, 0)), 120);
    const until = str(a.until);
    if (wait > 0 || until) await ctx.jobs.waitFor(id, (wait || 30) * 1000, ctx.signal, until || undefined);
    const r = ctx.jobs.read(id, wait > 0 || !!until);
    if (!r) return unknownJob(id, ctx.jobs);
    const state = r.view.status === "running" ? `still running${r.ports.length ? `, listening on ${r.ports.join(", ")}` : ""}` : `${r.view.status}${r.view.code !== null ? `, exit ${r.view.code}` : ""}`;
    const body = clip(cleanOutput(r.output).trimEnd());
    const dropped = r.skipped ? `[${r.skipped} earlier characters were dropped${r.file && !ctx.root ? `; the whole output is in ${r.file}: read the part you need with Read` : ""}]\n` : "";
    // Asking again and again is what a wake is for: once, at the second empty read, the answer says so instead of nothing.
    const nudge = r.nudge ? `\n[Nothing new since your last two reads. ${r.wakes ? "You are woken when it ends or prints what you watch for, so do not ask again: do other work or finish your answer." : `It will not wake you. Wait instead of asking again: ${example({ job_id: r.view.id, wait: 60 })}`}]` : "";
    return `${dropped}${body || "(no new output)"}\n[${r.view.id}: ${state}]${nudge}`;
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
    if (text && !ctx.jobs.type(id, a.enter === false ? text : `${text}\n`)) return `Error: ${id} cannot be typed to: it ended, was taken back after a restart (its input is gone), or was not started with interactive:true. Start the program again: Bash ${example({ command: "<the program>", interactive: true })}`;
    if (a.end === true && !ctx.jobs.endInput(id)) return `Error: the input of ${id} could not be ended.`;
    return `Typed to ${id}. Read what it printed with BashOutput (job_id "${id}", wait 2).`;
  },
};

export const killShell: Tool = {
  name: "KillShell",
  readOnly: false,
  description: "Stop a background command and everything it started. It is asked to quit first and forced after a few seconds.",
  parameters: { type: "object", properties: { job_id: { type: "string" } }, required: ["job_id"] },
  offeredWhen: ({ jobs }) => jobs > 0,
  title: (a) => `Stop ${str(a.job_id)}`,
  async run(a, ctx) {
    const id = str(a.job_id), before = ctx.jobs.list().find((j) => j.id === id)?.status, v = ctx.jobs.stop(id, true);
    return v ? `${v.id} is ${before === "running" ? "stopping" : v.status}.` : unknownJob(id, ctx.jobs);
  },
};
