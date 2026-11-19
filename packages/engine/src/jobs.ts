import { spawn, type ChildProcess } from "node:child_process";
import type { EngineEvent } from "@navvied/protocol";
import { killTree, usesProcessGroups } from "./platform.ts";
import { Redactor } from "./redact.ts";
import { QUIET_ENV } from "./tools/util.ts";

export type JobStatus = "running" | "done" | "failed" | "stopped";

export interface JobView { id: string; title: string; status: JobStatus; code: number | null; startedAt: number }

const KEEP = 400_000;
/** How many commands may be kept: finished ones are forgotten, oldest first, to make room; running ones are never. */
export const MOST_JOBS = 16;
/** How long a program asked to quit has before it is forced. */
const QUIT_MS = 3000;
/** After a stop, how long a job's end is waited for. Something it started that got away can hold its output open long after. */
const STOP_GRACE_MS = 1500;
const alive = new Set<Jobs>();
let guarded = false;

/** A program that dies must not leave servers running behind it. */
function guard(): void {
  if (guarded) return;
  guarded = true;
  process.on("exit", () => { for (const jobs of alive) jobs.stopAll(); });
  // Being stopped (a closed terminal, a service stop) must not leave servers running either: `exit` does not run for these.
  for (const [name, code] of [["SIGTERM", 143], ["SIGHUP", 129]] as const) process.once(name, () => { for (const jobs of alive) jobs.stopAll(); process.exit(code); });
}

interface Job extends JobView { /** Someone may type to it (BashInput). */ interactive: boolean; child: ChildProcess; output: string; dropped: number; read: number; ended: boolean; /** The model has been told it ended (by reading it, or by the line that says so). */ told: boolean; endedAt?: number; /** Makes what it prints safe as it arrives: what is kept here has no secret in it. */ safe: Redactor }

/** Commands that keep running after the turn that started them, such as a development server. */
export class Jobs {
  readonly #jobs = new Map<string, Job>();
  #next = 1;

  constructor(private readonly emit: (e: EngineEvent) => void, private readonly now: () => number = Date.now) {
    alive.add(this);
    guard();
  }

  /** `interactive`: its input stays open, for BashInput to type to. Otherwise nobody can type to it and it sees the end of its input at once. */
  start(argv: string[], cwd: string, title: string, env?: NodeJS.ProcessEnv, interactive = false): JobView {
    const [cmd, ...args] = argv;
    const child = spawn(cmd ?? "", args, { cwd, env: { ...process.env, ...QUIET_ENV, ...env }, detached: usesProcessGroups(), windowsHide: true, stdio: [interactive ? "pipe" : "ignore", "pipe", "pipe"] });
    return this.#track(child, title, interactive, "", false);
  }

  /** Takes over a command that is already running, as one that ran out of its time in the foreground: `printed` is what it has said so far, all of it already shown to the model. */
  adopt(child: ChildProcess, title: string, printed: string): JobView {
    return this.#track(child, title, false, printed, true);
  }

  #track(child: ChildProcess, title: string, interactive: boolean, printed: string, shown: boolean): JobView {
    const id = `job${this.#next++}`;
    const safe = new Redactor();
    const first = printed ? safe.push(printed) + safe.end() : "";
    const job: Job = { id, title, interactive, status: "running", code: null, startedAt: this.now(), child, output: first, dropped: 0, read: shown ? first.length : 0, ended: false, told: false, safe };
    this.#jobs.set(id, job);
    const collect = (d: Buffer): void => {
      job.output += job.safe.push(d.toString("utf8"));
      if (job.output.length > KEEP) { const cut = job.output.length - KEEP; job.output = job.output.slice(cut); job.dropped += cut; }
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    child.on("error", (e) => { collect(Buffer.from(`Error: ${e.message}\n`)); this.#end(job, null); });
    child.on("close", (code) => this.#end(job, code));
    this.emit({ ev: "job", id, title, status: "running", startedAt: job.startedAt });
    return view(job);
  }

  /**
   * Whether another command can be started. Finished ones are forgotten, the oldest first, to make room; when all are running there
   * is none, and the answer is a sentence saying how to make some.
   */
  room(): string | undefined {
    for (const [id, job] of this.#jobs) { if (this.#jobs.size < MOST_JOBS) break; if (job.status !== "running") this.#jobs.delete(id); }
    if (this.#jobs.size < MOST_JOBS) return undefined;
    const oldest = [...this.#jobs.values()][0]!;
    return `Error: ${MOST_JOBS} commands are already running in the background. Stop one with KillShell first (${oldest.id}, the oldest, is "${oldest.title.slice(0, 60)}"): KillShell {"job_id": "${oldest.id}"}. Then start this again.`;
  }

  /** The commands that ended since the model last heard of them. Reading a job is hearing of it; so is `told`, once the news is sent. */
  news(): { id: string; status: JobStatus; code: number | null; ms: number }[] {
    return [...this.#jobs.values()].filter((j) => j.ended && !j.told).map((j) => ({ id: j.id, status: j.status, code: j.code, ms: (j.endedAt ?? this.now()) - j.startedAt }));
  }

  told(ids: readonly string[]): void { for (const id of ids) { const job = this.#jobs.get(id); if (job) job.told = true; } }

  list(): JobView[] { return [...this.#jobs.values()].map(view); }

  get running(): number { return [...this.#jobs.values()].filter((j) => j.status === "running").length; }

  /** How many running jobs can be typed to. */
  get typable(): number { return [...this.#jobs.values()].filter((j) => j.status === "running" && j.interactive).length; }

  /** Types to a job. `false` when it is not one that can be typed to, or has ended. */
  type(id: string, text: string): boolean {
    const job = this.#jobs.get(id);
    if (!job || !job.interactive || job.status !== "running" || !job.child.stdin?.writable) return false;
    try { job.child.stdin.write(text); return true; } catch { return false; }
  }

  /** Ends a job's input, as Ctrl-D does. */
  endInput(id: string): boolean {
    const job = this.#jobs.get(id);
    if (!job || !job.interactive || job.status !== "running") return false;
    try { job.child.stdin?.end(); return true; } catch { return false; }
  }

  /** What the job printed since it was last read, and how it is doing. */
  read(id: string): { view: JobView; output: string; skipped: number; ports: number[] } | undefined {
    const job = this.#jobs.get(id);
    if (!job) return undefined;
    if (job.ended) job.told = true;
    const from = Math.max(0, job.read - job.dropped);
    const skipped = Math.max(0, job.dropped - job.read);
    const output = job.output.slice(from);
    job.read = job.dropped + job.output.length;
    return { view: view(job), output, skipped, ports: job.status === "running" ? portsIn(job.output) : [] };
  }

  /**
   * Waits until the job has printed something new or has ended, for at most `ms`, or until `signal` aborts. With `until`, it waits
   * for that text to be in what the job printed (any case) instead of for anything new.
   */
  async waitFor(id: string, ms: number, signal: AbortSignal, until?: string): Promise<void> {
    const job = this.#jobs.get(id);
    if (!job) return;
    const end = this.now() + ms, needle = until?.toLowerCase();
    const waiting = (): boolean => (needle === undefined ? job.dropped + job.output.length === job.read : !job.output.toLowerCase().includes(needle));
    while (job.status === "running" && waiting() && this.now() < end && !signal.aborted) await new Promise((r) => setTimeout(r, 100));
  }

  /** Stops a job and everything it started. `gently`: it is asked to quit first and has a few seconds before it is forced (not on Windows, which has no such request for a program running without a window). */
  stop(id: string, gently = false): JobView | undefined {
    const job = this.#jobs.get(id);
    if (!job) return undefined;
    this.#halt(job, gently);
    return view(job);
  }

  stopAll(): void { for (const job of this.#jobs.values()) this.#halt(job); }

  close(): void { this.stopAll(); alive.delete(this); }

  #halt(job: Job, gently = false): void {
    if (job.status !== "running") return;
    job.status = "stopped";
    const ask = gently && usesProcessGroups() && job.child.pid !== undefined;
    if (ask) { try { process.kill(-job.child.pid!, "SIGTERM"); } catch { /* already gone */ } } else killTree(job.child);
    const force = (): void => { if (!job.ended) killTree(job.child); setTimeout(() => this.#end(job, null), STOP_GRACE_MS).unref(); };
    if (ask) setTimeout(force, QUIT_MS).unref(); else force();
  }

  #end(job: Job, code: number | null): void {
    if (job.ended) return;
    job.ended = true;
    job.endedAt = this.now();
    if (job.status === "running") job.status = code === 0 ? "done" : "failed";
    job.code = code;
    job.output += job.safe.end();
    const last = lastLine(job.output);
    this.emit({ ev: "job", id: job.id, title: job.title, status: job.status, startedAt: job.startedAt, ...(code !== null ? { code } : {}), ...(last ? { last } : {}) });
  }
}

const view = (j: Job): JobView => ({ id: j.id, title: j.title, status: j.status, code: j.code, startedAt: j.startedAt });

/** The ports a program says it listens on (`localhost:3000`, `http://0.0.0.0:8080`, `listening on port 5173`), without repeats. */
export function portsIn(output: string): number[] {
  const found = new Set<number>();
  for (const m of output.matchAll(/(?:localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1?\]|\*):(\d{2,5})\b|\bports?\s+(\d{2,5})\b/gi)) {
    const port = Number(m[1] ?? m[2]);
    if (port > 0 && port <= 65535) found.add(port);
  }
  return [...found].slice(0, 5);
}

const lastLine = (output: string): string => (output.trimEnd().split(/\r?\n/).pop() ?? "").slice(0, 200);
