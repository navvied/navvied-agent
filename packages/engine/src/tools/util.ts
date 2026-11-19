import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { killTree, usesProcessGroups } from "../platform.ts";

export type Args = Record<string, unknown>;

export const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
export const num = (v: unknown, fallback: number): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

export const abs = (cwd: string, p: unknown): string => { const s = str(p); return isAbsolute(s) ? s : resolve(cwd, s); };

/** A path with every link in it followed, even when the last parts do not exist yet (a file about to be written). */
function followed(path: string): string {
  const rest: string[] = [];
  let here = resolve(path);
  while (!existsSync(here) && dirname(here) !== here) { rest.unshift(here.slice(dirname(here).length).replace(/^[\\/]/, "")); here = dirname(here); }
  try { here = realpathSync(here); } catch { /* it stays as it is */ }
  return join(here, ...rest);
}

/**
 * Where a tool should work for `p`: like `abs`, and, when the conversation is held to a folder (`ctx.root`), nothing outside it:
 * not by `..`, not by an absolute path, not through a link.
 */
export function place(ctx: { cwd: string; root?: string }, p: unknown): string {
  const full = abs(ctx.cwd, p);
  if (!ctx.root) return full;
  const inside = relative(followed(ctx.root), followed(full));
  if (inside === ".." || inside.startsWith(`..${"/"}`) || inside.startsWith("..\\") || isAbsolute(inside)) throw new Error(`that is outside the folder this conversation may use (${ctx.root})`);
  return full;
}

export const MAX_OUTPUT = 30_000;

/** How much text one tool result may bring into the conversation: a share of the model's window, so a small model is not flooded by one search and a large one is not starved. */
export const outputBudget = (window: number | undefined): number => Math.min(MAX_OUTPUT, Math.max(6_000, Math.round((window ?? 200_000) * 0.12)));

/** Where a result that is too long is cut: a file is read from its start, so most of it is kept there; elsewhere the two ends are equal. */
const HEAD_SHARE: Record<string, number> = { Read: 0.7, Bash: 0.3 };

/**
 * The last guard on what a tool gives the model, whatever the tool: a result over the window's budget (with a little room, so a tool
 * that has already cut to it is not cut twice) is cut in the middle, and the model is told how to ask for less.
 */
export function withinBudget(tool: string, text: string, window: number | undefined): string {
  const budget = outputBudget(window);
  if (text.length <= Math.ceil(budget * 1.25)) return text;
  return `${clip(text, budget, HEAD_SHARE[tool] ?? 0.5)}\n[the result was cut to fit: ask for less (a narrower pattern, a path or glob, offset and limit)]`;
}

/** At most `most` lines, and a sentence about the rest when there are more: how the lists a tool returns (matches, files) are kept short. */
export function firstLines(text: string, most: number, what: string, hint: string): string {
  const lines = text.split("\n");
  if (lines.length <= most) return text;
  return `${lines.slice(0, most).join("\n")}\n[${lines.length} ${what}, ${most} shown: ${hint}]`;
}
/** How long to wait for a killed command to let go of its output before reporting without it, in milliseconds. */
const STOP_GRACE_MS = 1500;
/** How long to wait, after the command itself has ended, for what it left running behind it to let go of the output. */
const EXIT_GRACE_MS = 400;
/** What every command is told, so that nothing waits for a person who is not there: no pager, no editor, no prompt for a password. */
export const QUIET_ENV = { TERM: "dumb", NO_COLOR: "1", PAGER: "cat", GIT_PAGER: "cat", GIT_EDITOR: "true", GIT_TERMINAL_PROMPT: "0" } as const;

/** Keep the start and the end of long output — failures and summaries are usually at the end. */
export function clip(text: string, max = MAX_OUTPUT, headShare = 0.6): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * headShare), tail = max - head;
  return `${text.slice(0, head)}\n… [${text.length - max} characters omitted] …\n${text.slice(text.length - tail)}`;
}

/** Output that did not fit is kept whole in a file, so the model can read the part it needs instead of rerunning the command. Returns where, or nothing when it could not be saved. */
export function spill(text: string): string | undefined {
  try {
    const file = join(mkdtempSync(join(tmpdir(), "navvied-output-")), "output.txt");
    writeFileSync(file, text, { mode: 0o600 });
    return file;
  } catch { return undefined; }
}

/** What a person would see: colour and cursor codes removed, and a progress line that was redrawn many times (`\\r`) reduced to its last state. */
export function cleanOutput(text: string): string {
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\r\n/g, "\n")
    // One pass over each line: a pattern for "everything before the last \r" backtracks badly on a very long line.
    .split("\n").map((line) => line.slice(line.lastIndexOf("\r") + 1)).join("\n");
}

export interface RunResult { output: string; code: number | null; timedOut: boolean; interrupted: boolean; /** What ran out: the silence (no output for `idleMs`) or the whole time (`timeoutMs`). */ ranOut?: "silence" | "time"; /** The command was not killed at its timeout: it was handed on (see `onTimeout`). */ adopted?: boolean }

/**
 * Run a process, collect its output, and kill the whole process group on timeout or when `signal` aborts.
 * Never rejects: a failure to start is reported in `output`.
 */
export function run(argv: string[], opts: { cwd: string; signal: AbortSignal; timeoutMs: number; /** Time it may be silent: the clock is restarted by every bit of output, and `timeoutMs` is then the most it may take in all. */ idleMs?: number; env?: NodeJS.ProcessEnv; onChunk?: (text: string) => void; /** At the timeout: take the running command over (true) instead of killing it. */ onTimeout?: (child: ChildProcess, printed: string) => boolean }): Promise<RunResult> {
  return new Promise((done) => {
    const [cmd, ...args] = argv;
    if (!cmd) return done({ output: "Error: empty command", code: null, timedOut: false, interrupted: false });
    if (opts.signal.aborted) return done({ output: "", code: null, timedOut: false, interrupted: true });
    // Nobody types to a command: its input is closed, so a program that reads (cat, read, a prompt) ends at once instead of waiting out the timeout.
    const child = spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...QUIET_ENV, ...opts.env }, detached: usesProcessGroups(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", timedOut = false, interrupted = false, settled = false, adopted = false, ranOut: RunResult["ranOut"];
    // After a kill the process may still hold its pipes through a child it started: do not wait for them for long.
    const stop = () => { killTree(child); const grace = setTimeout(() => finish(null), STOP_GRACE_MS); grace.unref?.(); };
    const fire = (why: "silence" | "time"): void => {
      if (timedOut) return;
      timedOut = true;
      ranOut = why;
      if (!opts.onTimeout?.(child, output)) return stop();
      // Handed on: this call is over, and nothing more of the command is shown through it.
      child.stdout.off("data", collect);
      child.stderr.off("data", collect);
      adopted = true;
      finish(null);
    };
    let timer = setTimeout(() => fire(opts.idleMs ? "silence" : "time"), opts.idleMs ?? opts.timeoutMs);
    const ceiling = opts.idleMs ? setTimeout(() => fire("time"), opts.timeoutMs) : undefined;
    const onAbort = () => { interrupted = true; stop(); };
    opts.signal.addEventListener("abort", onAbort, { once: true });
    const collect = (d: Buffer) => {
      const text = d.toString("utf8");
      if (output.length < 400_000) output += text;
      opts.onChunk?.(text);
      if (opts.idleMs && !settled) { clearTimeout(timer); timer = setTimeout(() => fire("silence"), opts.idleMs); }
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const finish = (code: number | null, extra = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(ceiling);
      opts.signal.removeEventListener("abort", onAbort);
      done({ output: output + extra, code, timedOut, interrupted, ...(ranOut ? { ranOut } : {}), ...(adopted ? { adopted } : {}) });
    };
    child.on("close", (code) => finish(code));
    // The command has ended but something it started (`server &`) still holds the output: report what there is, do not wait for it.
    child.on("exit", (code) => { const grace = setTimeout(() => finish(code), EXIT_GRACE_MS); grace.unref?.(); });
    child.on("error", (e) => finish(null, `Error: ${e.message}`));
  });
}
