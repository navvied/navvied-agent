import { spawn, type ChildProcess } from "node:child_process";
import type { EngineEvent } from "@navvied/protocol";
import { killTree, usesProcessGroups } from "./platform.ts";
import { QUIET_ENV } from "./tools/util.ts";

export type JobStatus = "running" | "done" | "failed" | "stopped";

export interface JobView { id: string; title: string; status: JobStatus; code: number | null; startedAt: number }

const KEEP = 400_000;
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

interface Job extends JobView { /** Someone may type to it (BashInput). */ interactive: boolean; child: ChildProcess; output: string; dropped: number; read: number; ended: boolean }

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
    const id = `job${this.#next++}`;
    const child = spawn(cmd ?? "", args, { cwd, env: { ...process.env, ...QUIET_ENV, ...env }, detached: usesProcessGroups(), windowsHide: true, stdio: [interactive ? "pipe" : "ignore", "pipe", "pipe"] });
    const job: Job = { id, title, interactive, status: "running", code: null, startedAt: this.now(), child, output: "", dropped: 0, read: 0, ended: false };
    this.#jobs.set(id, job);
    const collect = (d: Buffer): void => {
      job.output += d.toString("utf8");
      if (job.output.length > KEEP) { const cut = job.output.length - KEEP; job.output = job.output.slice(cut); job.dropped += cut; }
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    child.on("error", (e) => { collect(Buffer.from(`Error: ${e.message}\n`)); this.#end(job, null); });
    child.on("close", (code) => this.#end(job, code));
    this.emit({ ev: "job", id, title, status: "running", startedAt: job.startedAt });
    return view(job);
  }

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
  read(id: string): { view: JobView; output: string; skipped: number } | undefined {
    const job = this.#jobs.get(id);
    if (!job) return undefined;
    const from = Math.max(0, job.read - job.dropped);
    const skipped = Math.max(0, job.dropped - job.read);
    const output = job.output.slice(from);
    job.read = job.dropped + job.output.length;
    return { view: view(job), output, skipped };
  }

  /** Waits until the job has printed something new or has ended, for at most `ms`, or until `signal` aborts. */
  async waitFor(id: string, ms: number, signal: AbortSignal): Promise<void> {
    const job = this.#jobs.get(id);
    if (!job) return;
    const until = this.now() + ms;
    while (job.status === "running" && job.dropped + job.output.length === job.read && this.now() < until && !signal.aborted) await new Promise((r) => setTimeout(r, 100));
  }

  stop(id: string): JobView | undefined {
    const job = this.#jobs.get(id);
    if (!job) return undefined;
    if (job.status === "running") { job.status = "stopped"; killTree(job.child); }
    return view(job);
  }

  stopAll(): void { for (const job of this.#jobs.values()) if (job.status === "running") { job.status = "stopped"; killTree(job.child); } }

  close(): void { this.stopAll(); alive.delete(this); }

  #end(job: Job, code: number | null): void {
    if (job.ended) return;
    job.ended = true;
    if (job.status === "running") job.status = code === 0 ? "done" : "failed";
    job.code = code;
    const last = lastLine(job.output);
    this.emit({ ev: "job", id: job.id, title: job.title, status: job.status, startedAt: job.startedAt, ...(code !== null ? { code } : {}), ...(last ? { last } : {}) });
  }
}

const view = (j: Job): JobView => ({ id: j.id, title: j.title, status: j.status, code: j.code, startedAt: j.startedAt });

const lastLine = (output: string): string => (output.trimEnd().split(/\r?\n/).pop() ?? "").slice(0, 200);
