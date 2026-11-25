import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { saidOf, scanPrompt } from "@navvied/engine";
import { selfArgv } from "./create.ts";
import { UNATTENDED, dueAt, type Job, type ScheduleStore } from "./schedules.ts";

const LONGEST_MS = 30 * 60_000;

export interface Finished { job: Job; code: number | null; text: string; file: string; /** Stopped before it finished. */ cancelled?: true }

/** Runs one task as `navvied run` in a process of its own, and keeps what it said in a file. Nobody is asked anything: a task in `plan` mode only reads, one in `auto` mode is held to the permission rules. The prompt is scanned first, every time: a task whose prompt now carries an injection is not started. */
export function runJob(job: Job, env: Record<string, string | undefined>, where: string, now: () => number = Date.now, signal?: AbortSignal): Promise<Finished> {
  const [cmd, ...head] = selfArgv();
  const args = [...head, "run", job.prompt, "--last", ...(job.kind === "chat" ? ["--kind", "chat"] : ["--mode", job.mode, "--cwd", job.cwd]), ...(job.mode === "auto" && job.kind !== "chat" ? ["--yes"] : [])];
  return new Promise((done) => {
    let text = "";
    let cancelled = false;
    const finish = (code: number | null): void => {
      const dir = join(where, job.id);
      const file = join(dir, `${new Date(now()).toISOString().replace(/[:.]/g, "-")}.txt`);
      try { mkdirSync(dir, { recursive: true }); writeFileSync(file, `${job.prompt}\n\n--- exit ${code}\n${text.trim()}\n`); } catch { /* the result is still returned */ }
      done({ job, code, text: text.trim(), file, ...(cancelled ? { cancelled: true as const } : {}) });
    };
    const found = scanPrompt(job.prompt);
    if (found.length) { text = `Not started: the prompt has ${found.join(" and ")}.`; finish(null); return; }
    const child = spawn(cmd!, args, { cwd: job.cwd, env: { ...process.env, ...env, [UNATTENDED]: "1" } as Record<string, string>, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const timer = setTimeout(() => { text += "\n[stopped: it took longer than 30 minutes]"; child.kill(); }, LONGEST_MS);
    const stop = (): void => { cancelled = true; text += "\n[stopped: it was cancelled]"; child.kill(); };
    if (signal?.aborted) stop(); else signal?.addEventListener("abort", stop, { once: true });
    const take = (d: Buffer): void => { text = (text + d.toString("utf8")).slice(0, 40_000); };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    const end = (code: number | null): void => { clearTimeout(timer); signal?.removeEventListener("abort", stop); finish(code); };
    child.on("error", (e) => { text += e.message; end(null); });
    child.on("close", (code) => end(code));
  });
}

/**
 * The runs of this program: the one place that starts a task (the hub's timer, a person's screen, the Schedule tool). It remembers
 * which are going so none starts twice, can stop one, and writes the end of a run to the file of tasks.
 */
export class JobRunner {
  readonly #going = new Map<string, AbortController>();

  constructor(private readonly store: ScheduleStore, private readonly o: { env: Record<string, string | undefined>; where: string; run?: typeof runJob; now?: () => number; /** Said when a run starts and when it ends. */ changed?: () => void }) {}

  running(id: string): boolean { return this.#going.has(id); }

  /** Starts the task now, or nothing when it is already going. The promise ends with the run. */
  start(job: Job, due?: number): Promise<Finished> | undefined {
    if (this.#going.has(job.id)) return undefined;
    const now = this.o.now ?? Date.now, stop = new AbortController();
    this.#going.set(job.id, stop);
    this.store.markRun(job.id, now(), due);
    this.o.changed?.();
    return (this.o.run ?? runJob)(job, this.o.env, this.o.where, now, stop.signal)
      .catch((): Finished => ({ job, code: null, text: "", file: "" }))
      .then((f) => { this.store.finished(job.id, f.code, f.file || undefined, now(), f.cancelled === true, saidOf(f.text)); return f; })
      .finally(() => { this.#going.delete(job.id); this.o.changed?.(); });
  }

  /** Stops the run that is going; false when none is. */
  cancel(id: string): boolean {
    const stop = this.#going.get(id);
    stop?.abort();
    return stop !== undefined;
  }
}

/** Starts every task whose time has come, each once, and says when each has finished. A task that was due while nothing ran starts now and is recorded as late. */
export function startDue(store: ScheduleStore, env: Record<string, string | undefined>, where: string, finished: (f: Finished) => void, now: () => number = Date.now, runner = new JobRunner(store, { env, where, now })): Promise<Finished[]> {
  const due = store.list().flatMap((j) => { const at = dueAt(j, now()); return at === undefined ? [] : [{ job: j, at }]; });
  return Promise.all(due.flatMap((d) => { const run = runner.start(d.job, d.at); return run ? [run.then((f) => { finished(f); return f; })] : []; }));
}
