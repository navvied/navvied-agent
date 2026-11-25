import { CloudSchedule, type ScheduleBackend, type ScheduleInput, type ScheduleJob, type ScheduleRun } from "@navvied/engine";
import { scheduledDir } from "./config.ts";
import { JobRunner } from "./schedule-run.ts";
import { MOST_JOBS, ScheduleStore, fieldsOf as fields, UNATTENDED, nextDue, timingText, type Job, type RunRecord } from "./schedules.ts";

const plain = (text: string): string => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
const outcome = (r: RunRecord): ScheduleRun["outcome"] => (r.code === undefined ? "running" : r.code === 0 ? "ok" : "failed");

/** The Schedule tool's jobs on this computer: the file of tasks the person's own list and the `navvied schedule` command use. */
export class ComputerSchedule implements ScheduleBackend {
  readonly about = "It runs only while navvied is open on this computer.";
  readonly maxJobs = MOST_JOBS;

  constructor(private readonly store: ScheduleStore, private readonly runner: JobRunner, private readonly o: { cwd: string; chat: boolean; /** False inside a run nobody started by hand: it may look, never change. */ canChange: boolean; now?: () => number; /** Said after the list changed, so a window showing it can draw it again. */ changed?: () => void }) {}

  get canChange(): boolean { return this.o.canChange; }
  now = (): number => (this.o.now ?? Date.now)();

  #view(j: Job): ScheduleJob {
    const last = j.runs?.[0] ?? (j.lastCode !== undefined && j.lastRun !== undefined ? { at: j.lastRun, code: j.lastCode } : undefined);
    const next = nextDue(j, this.now());
    return { id: j.id, name: j.title ?? j.prompt.replace(/\s+/g, " ").slice(0, 40), prompt: j.prompt, when: timingText(j), ...(j.tz ? { tz: j.tz } : {}), mode: j.mode, enabled: !j.disabled, ...(next !== undefined ? { next } : {}), ...(last ? { lastOutcome: outcome(last), lastAt: last.at } : {}) };
  }

  async list(): Promise<ScheduleJob[]> { return this.store.list().map((j) => this.#view(j)); }

  async #done(made: Job | string): Promise<ScheduleJob | string> {
    if (typeof made === "string") return plain(made);
    this.o.changed?.();
    return this.#view(made);
  }

  async create(i: ScheduleInput): Promise<ScheduleJob | string> {
    return this.#done(this.store.add({ ...fields(i.timing), ...(i.tz ? { tz: i.tz } : {}), prompt: i.prompt, title: i.name, cwd: this.o.cwd, mode: i.mode, ...(this.o.chat ? { kind: "chat" as const } : {}) }, this.now()));
  }

  async update(id: string, c: Partial<ScheduleInput>): Promise<ScheduleJob | string> {
    return this.#done(this.store.update(id, { ...(c.name ? { title: c.name } : {}), ...(c.prompt ? { prompt: c.prompt } : {}), ...(c.timing ? fields(c.timing) : {}), ...(c.tz ? { tz: c.tz } : {}), ...(c.mode ? { mode: c.mode } : {}) }, this.now()));
  }

  async setEnabled(id: string, enabled: boolean): Promise<ScheduleJob | string> { return this.#done(this.store.update(id, { enabled }, this.now())); }

  async remove(id: string): Promise<true | string> {
    if (!this.store.remove(id)) return "That job was not found.";
    this.o.changed?.();
    return true;
  }

  async runs(id: string): Promise<ScheduleRun[] | string> {
    const j = this.store.list().find((x) => x.id === id);
    if (!j) return "That job was not found.";
    return (j.runs ?? []).slice(0, 5).map((r) => ({ at: r.at, outcome: outcome(r), ...(r.due !== undefined ? { due: r.due } : {}), ...(r.cancelled ? { note: "it was stopped before it finished" } : r.file ? { note: `what it said is kept in ${r.file}` } : r.code === null ? { note: "it could not start" } : {}) }));
  }

  async run(id: string): Promise<true | string> {
    const job = this.store.list().find((x) => x.id === id);
    if (!job) return "That job was not found.";
    if (!this.runner.start(job)) return "That job is already running.";
    return true;
  }

  async cancel(id: string): Promise<true | string> {
    return this.runner.cancel(id) ? true : "That job is not running here.";
  }
}

/** Where a conversation keeps its scheduled jobs: the cloud's for a hosted session, this computer's own file otherwise (and inside a run nobody started, only to look at). */
export function scheduleFor(o: { env: Record<string, string | undefined>; file: string; webProxy?: { url: string; token: string } | undefined; cwd: string; chat: boolean; changed?: (() => void) | undefined; /** The hub's runs; a program without a hub keeps its own. */ runner?: (() => JobRunner) | undefined }): ScheduleBackend {
  if (o.webProxy) return new CloudSchedule(o.webProxy);
  const store = new ScheduleStore(o.file);
  return new ComputerSchedule(store, o.runner?.() ?? new JobRunner(store, { env: o.env, where: scheduledDir(o.env), ...(o.changed ? { changed: o.changed } : {}) }), { cwd: o.cwd, chat: o.chat, canChange: o.env[UNATTENDED] !== "1", ...(o.changed ? { changed: o.changed } : {}) });
}
