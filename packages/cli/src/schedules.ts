import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { dueSince, parseCron } from "./cron.ts";

export interface Job {
  id: string;
  cron: string;
  prompt: string;
  cwd: string;
  /** What it may do with nobody to ask: `plan` only reads and plans, `auto` may change things (the permission rules still apply). */
  mode: "plan" | "auto";
  created: number;
  /** When it was last started, in ms since the epoch; none until it has run. */
  lastRun?: number;
  /** A name for the list. */
  title?: string;
  /** Turned off: it stays in the list and does not run (unless run by hand). */
  disabled?: boolean;
  /** What it works in: an agent in the folder, or a chat (then `cwd` is not used). */
  kind?: "agent" | "chat";
  /** How the last run ended: the exit code (0 = fine). */
  lastCode?: number | null;
}

/** The tasks the person scheduled, kept in a private file. */
export class ScheduleStore {
  constructor(private readonly path: string) {}

  list(): Job[] {
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as { jobs?: unknown };
      return Array.isArray(raw.jobs) ? raw.jobs.filter((j): j is Job => typeof j === "object" && j !== null && typeof (j as Job).id === "string" && typeof (j as Job).cron === "string" && typeof (j as Job).prompt === "string") : [];
    } catch { return []; }
  }

  #save(jobs: Job[]): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ jobs }, null, 2)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.path);
  }

  add(input: { cron: string; prompt: string; cwd: string; mode?: "plan" | "auto"; title?: string; kind?: "agent" | "chat" }, now = Date.now()): Job | string {
    const parsed = parseCron(input.cron);
    if (typeof parsed === "string") return parsed;
    if (!input.prompt.trim()) return "say what the task is";
    const jobs = this.list();
    if (jobs.length >= 50) return "that is the most tasks (50): remove one first";
    const job: Job = { id: randomBytes(3).toString("hex"), cron: input.cron.trim(), prompt: input.prompt.trim().slice(0, 4000), cwd: input.cwd, mode: input.mode ?? "plan", created: now, ...(input.title?.trim() ? { title: input.title.trim().slice(0, 80) } : {}), ...(input.kind === "chat" ? { kind: "chat" as const } : {}), lastRun: now };
    this.#save([...jobs, job]);
    return job;
  }

  remove(id: string): boolean {
    const jobs = this.list();
    const rest = jobs.filter((j) => j.id !== id);
    if (rest.length === jobs.length) return false;
    this.#save(rest);
    return true;
  }

  /** Changes a task. Returns the task, or why it could not be changed. */
  update(id: string, change: { title?: string; cron?: string; prompt?: string; mode?: "plan" | "auto"; cwd?: string; enabled?: boolean }): Job | string {
    const jobs = this.list();
    const had = jobs.find((j) => j.id === id);
    if (!had) return "that task was not found";
    if (change.cron !== undefined) { const parsed = parseCron(change.cron); if (typeof parsed === "string") return parsed; }
    if (change.prompt !== undefined && !change.prompt.trim()) return "say what the task is";
    const next: Job = {
      ...had,
      ...(change.title !== undefined ? { title: change.title.trim().slice(0, 80) } : {}),
      ...(change.cron !== undefined ? { cron: change.cron.trim() } : {}),
      ...(change.prompt !== undefined ? { prompt: change.prompt.trim().slice(0, 4000) } : {}),
      ...(change.mode !== undefined ? { mode: change.mode } : {}),
      ...(change.cwd !== undefined ? { cwd: change.cwd } : {}),
    };
    if (change.enabled !== undefined) { if (change.enabled) delete next.disabled; else next.disabled = true; }
    this.#save(jobs.map((j) => (j.id === id ? next : j)));
    return next;
  }

  /** Remembers how a run ended. */
  finished(id: string, code: number | null): void { this.#save(this.list().map((j) => (j.id === id ? { ...j, lastCode: code } : j))); }

  markRun(id: string, at: number): void { this.#save(this.list().map((j) => (j.id === id ? { ...j, lastRun: at } : j))); }
  get exists(): boolean { return existsSync(this.path); }
}

/** Tasks whose time has come since they last ran. A task whose time came more than once while nothing was running is started once, not many times. */
export function dueJobs(jobs: readonly Job[], now: number): Job[] {
  return jobs.filter((j) => { if (j.disabled) return false; const c = parseCron(j.cron); return typeof c !== "string" && dueSince(c, j.lastRun ?? j.created, now) !== undefined; });
}
