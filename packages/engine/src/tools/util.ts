import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, realpathSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { groupAlive, killTree, usesProcessGroups } from "../platform.ts";
import { Redactor } from "../redact.ts";
import { expandHome, homeFrom } from "../where.ts";
import { releaseChild, withGuardStdio } from "../sandbox/handshake.ts";

export type Args = Record<string, unknown>;

export const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
export const num = (v: unknown, fallback: number): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

export const abs = (cwd: string, p: unknown, home?: string): string => resolve(cwd, expandHome(str(p), home ?? homeFrom()));

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
export function place(ctx: { cwd: string; root?: string; home?: string }, p: unknown): string {
  const full = abs(ctx.cwd, p, ctx.home);
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
/** How long the programs a shell left behind are given to end before they count as running on. */
const LEFT_SETTLE_MS = 300;
/** What every command is told, so that nothing waits for a person who is not there: no pager, no editor, no prompt for a password. */
export const QUIET_ENV = { TERM: "dumb", NO_COLOR: "1", PAGER: "cat", GIT_PAGER: "cat", GIT_EDITOR: "true", GIT_TERMINAL_PROMPT: "0" } as const;

/** Keep the start and the end of long output — failures and summaries are usually at the end. */
export function clip(text: string, max = MAX_OUTPUT, headShare = 0.6): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * headShare), tail = max - head;
  return `${text.slice(0, head)}\n… [${text.length - max} characters omitted] …\n${text.slice(text.length - tail)}`;
}

/** Where output that did not fit is kept; the model may read it without being asked. */
export const SPILL_DIR = join(tmpdir(), "navvied-output");

/** Output that did not fit is kept whole in a file, so the model can read the part it needs instead of rerunning the command. Returns where, or nothing when it could not be saved. */
export function spill(text: string): string | undefined {
  try {
    mkdirSync(SPILL_DIR, { recursive: true });
    const file = join(mkdtempSync(join(SPILL_DIR, "o-")), "output.txt");
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

/** Output kept whole in memory up to this many characters; past it, the whole goes on to a file as it arrives. */
const WHOLE = 1_000_000;
/** What memory keeps once the output is in a file: how much of its start and of its end. */
const KEEP_HEAD = 50_000, KEEP_TAIL = 150_000;

/**
 * What a command printed. A short output is held whole. A long one is written to a file as it arrives (with the secrets in it hidden), and
 * memory keeps only its start and its end, so a command that prints for an hour costs no more than one that prints a page, and the end,
 * where failures and summaries are, is never lost to a cut.
 */
export class Capture {
  #head = "";
  #tail = "";
  #total = 0;
  #fd: number | undefined;
  #safe: Redactor | undefined;
  /** Where the whole output is, once it did not fit in memory. */
  file: string | undefined;

  constructor(private readonly whole: number = WHOLE) {}

  push(text: string): void {
    this.#total += text.length;
    if (this.#fd === undefined) {
      this.#head += text;
      if (this.#total > this.whole) this.#overflow();
      return;
    }
    this.#write(this.#safe!.push(text));
    this.#tail = (this.#tail + text).slice(-KEEP_TAIL);
  }

  #overflow(): void {
    const all = this.#head;
    try {
      this.file = join(mkdtempSync(join(tmpdir(), "navvied-output-")), "output.txt");
      this.#fd = openSync(this.file, "w", 0o600);
      this.#safe = new Redactor();
      this.#write(this.#safe.push(all));
    } catch { this.file = undefined; this.#fd = undefined; this.#head = all.slice(0, KEEP_HEAD) + all.slice(-KEEP_TAIL); return; }
    this.#head = all.slice(0, KEEP_HEAD);
    this.#tail = all.slice(-KEEP_TAIL);
  }

  #write(text: string): void { try { writeSync(this.#fd!, text); } catch { /* the disk is full: what memory keeps is still right */ } }

  /** The start and the end of what was printed (all of it, when it is short). */
  text(): string { return this.#fd === undefined ? this.#head : `${this.#head}\n${this.#tail}`; }

  /** Nothing more will come. */
  close(): void {
    if (this.#fd === undefined) return;
    this.#write(this.#safe!.end());
    try { closeSync(this.#fd); } catch { /* closed */ }
    this.#fd = undefined;
    this.#head = `${this.#head}\n${this.#tail}`; this.#tail = "";
  }
}

export interface RunResult { output: string; code: number | null; timedOut: boolean; interrupted: boolean; /** What ran out: the silence (no output for `idleMs`) or the whole time (`timeoutMs`). */ ranOut?: "silence" | "time" | "left"; /** The signal that ended the command, when one did. */ signal?: string; /** The command was not killed at its timeout: it was handed on (see `onTimeout`). */ adopted?: boolean; /** Where the whole output is, when it was too long to keep in memory. */ file?: string }

/**
 * Run a process, collect its output, and kill the whole process group on timeout or when `signal` aborts.
 * Never rejects: a failure to start is reported in `output`.
 */
export function run(argv: string[], opts: { cwd: string; signal: AbortSignal; timeoutMs: number; /** Time it may be silent: the clock is restarted by every bit of output, and `timeoutMs` is then the most it may take in all. */ idleMs?: number; /** What the command starts with (this program's own environment when not given). */ /** Most output kept whole in memory, in characters (default 1,000,000); more goes to a file. */ maxOutput?: number; env?: NodeJS.ProcessEnv; onChunk?: (text: string) => void; /** Called once the command has started. */ onSpawn?: (child: ChildProcess) => void; /** The command is confined with a guard that waits to be released (`Launch.guarded`). */ guarded?: boolean; /** At the timeout: take the running command over (true) instead of killing it. */ onTimeout?: (child: ChildProcess, printed: string) => boolean; /** When the shell has ended and programs it started (`server &`) still run in its group: take them over (true) instead of leaving them behind. */ onLeft?: (child: ChildProcess, code: number | null, printed: string) => boolean }): Promise<RunResult> {
  return new Promise((done) => {
    const [cmd, ...args] = argv;
    if (!cmd) return done({ output: "Error: empty command", code: null, timedOut: false, interrupted: false });
    if (opts.signal.aborted) return done({ output: "", code: null, timedOut: false, interrupted: true });
    // Nobody types to a command: its input is closed, so a program that reads (cat, read, a prompt) ends at once instead of waiting out the timeout.
    const child = spawn(cmd, args, { cwd: opts.cwd, env: { ...(opts.env ?? process.env), ...QUIET_ENV }, detached: usesProcessGroups(), windowsHide: true, stdio: withGuardStdio(["ignore", "pipe", "pipe"], opts.guarded === true) });
    if (opts.guarded) releaseChild(child);
    opts.onSpawn?.(child);
    const output = new Capture(opts.maxOutput);
    let timedOut = false, interrupted = false, settled = false, adopted = false, ranOut: RunResult["ranOut"];
    // After a kill the process may still hold its pipes through a child it started: do not wait for them for long.
    const stop = () => { killTree(child); const grace = setTimeout(() => finish(null), STOP_GRACE_MS); grace.unref?.(); };
    const fire = (why: "silence" | "time"): void => {
      if (timedOut) return;
      timedOut = true;
      ranOut = why;
      if (!opts.onTimeout?.(child, output.text())) return stop();
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
      output.push(text);
      opts.onChunk?.(text);
      if (opts.idleMs && !settled) { clearTimeout(timer); timer = setTimeout(() => fire("silence"), opts.idleMs); }
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const finish = (code: number | null, extra = "", signal?: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(ceiling);
      opts.signal.removeEventListener("abort", onAbort);
      output.push(extra);
      output.close();
      done({ output: output.text(), code, timedOut, interrupted, ...(ranOut ? { ranOut } : {}), ...(signal && !timedOut && !interrupted ? { signal } : {}), ...(adopted ? { adopted } : {}), ...(output.file ? { file: output.file } : {}) });
    };
    // The shell has ended. What it started and left running in its group (`server &`) must not be left outside every list: it goes on as a job. A pipeline's last
    // stragglers (`yes | head`) are gone within a moment, so they are waited for.
    const ended = (code: number | null, signal?: string | null): void => {
      if (settled || timedOut || interrupted || !opts.onLeft || !groupAlive(child.pid)) return finish(code, "", signal);
      const until = Date.now() + LEFT_SETTLE_MS;
      const look = (): void => {
        if (settled) return;
        if (groupAlive(child.pid) && Date.now() < until) { setTimeout(look, 20).unref?.(); return; }
        if (groupAlive(child.pid) && !interrupted && opts.onLeft!(child, code, output.text())) { child.stdout.off("data", collect); child.stderr.off("data", collect); adopted = true; ranOut = "left"; }
        finish(code, "", signal);
      };
      look();
    };
    child.on("close", (code, signal) => ended(code, signal));
    // The command has ended but something it started (`server &`) still holds the output: report what there is, do not wait for it.
    child.on("exit", (code) => { const grace = setTimeout(() => ended(code), EXIT_GRACE_MS); grace.unref?.(); });
    child.on("error", (e) => finish(null, `Error: ${e.message}`));
  });
}
