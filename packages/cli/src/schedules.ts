import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { SHORTEST_REPEAT_MS, isTimeZone } from "@navvied/engine";
import { dueSince, nextRun, parseCron } from "./cron.ts";

/** One start of a task. `code` is none while it runs and null when it could not start; `due` is only there when the start was late. */
export interface RunRecord { at: number; due?: number; code?: number | null; /** Where what it said is kept. */ file?: string }

const MOST_RUNS = 20;
export const MOST_JOBS = 50;
/** Set in the environment of a run that nobody started by hand: the Schedule tool in it may look, never change. */
export const UNATTENDED = "NAVVIED_SCHEDULED";
/** A start later than this after the time it was due is a missed run. */
export const LATE_MS = 120_000;

export interface Job {
  id: string;
  /** Five fields, or "" for a task that runs every so often (`every`) or once (`at`). */
  cron: string;
  /** Run every so many ms, counted from the last start. */
  every?: number;
  /** Run once, at this time in ms since the epoch. */
  at?: number;
  /** The time zone the cron fields are in; this computer's own when none. */
  tz?: string;
  /** The schedule counts from here when it was changed after the last start. */
  from?: number;
  /** The newest starts first, at most 20. */
  runs?: RunRecord[];
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

  add(input: { cron?: string; every?: number; at?: number; tz?: string; prompt: string; cwd: string; mode?: "plan" | "auto"; title?: string; kind?: "agent" | "chat" }, now = Date.now()): Job | string {
    const timing = checkTiming(input);
    if (typeof timing === "string") return timing;
    if (!input.prompt.trim()) return "say what the task is";
    const jobs = this.list();
    if (jobs.length >= MOST_JOBS) return `that is the most tasks (${MOST_JOBS}): remove one first`;
    const job: Job = { id: randomBytes(3).toString("hex"), prompt: input.prompt.trim().slice(0, 4000), cwd: input.cwd, mode: input.mode ?? "plan", ...timing, created: now, ...(input.title?.trim() ? { title: input.title.trim().slice(0, 80) } : {}), ...(input.kind === "chat" ? { kind: "chat" as const } : {}), lastRun: now };
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
  update(id: string, change: { title?: string; cron?: string; every?: number; at?: number; tz?: string; prompt?: string; mode?: "plan" | "auto"; cwd?: string; enabled?: boolean }, now = Date.now()): Job | string {
    const jobs = this.list();
    const had = jobs.find((j) => j.id === id);
    if (!had) return "that task was not found";
    const retimed = change.cron !== undefined || change.every !== undefined || change.at !== undefined;
    const timing = retimed || change.tz !== undefined ? checkTiming({ cron: retimed ? change.cron : had.cron, every: retimed ? change.every : had.every, at: retimed ? change.at : had.at, tz: change.tz ?? had.tz }) : undefined;
    if (typeof timing === "string") return timing;
    if (change.prompt !== undefined && !change.prompt.trim()) return "say what the task is";
    const { cron: _c, every: _e, at: _a, tz: _z, ...rest } = had;
    const next: Job = {
      ...(timing ? { ...rest, ...timing, ...(retimed ? { from: now } : {}) } : had),
      ...(change.title !== undefined ? { title: change.title.trim().slice(0, 80) } : {}),
      ...(change.prompt !== undefined ? { prompt: change.prompt.trim().slice(0, 4000) } : {}),
      ...(change.mode !== undefined ? { mode: change.mode } : {}),
      ...(change.cwd !== undefined ? { cwd: change.cwd } : {}),
    };
    if (change.enabled !== undefined) { if (change.enabled) { if (had.disabled) next.from = now; delete next.disabled; } else next.disabled = true; }
    this.#save(jobs.map((j) => (j.id === id ? next : j)));
    return next;
  }

  /** Remembers how a run ended: on the start that is still open, or, for a run started by hand, as a start of its own. */
  finished(id: string, code: number | null, file?: string, now = Date.now()): void {
    this.#save(this.list().map((j) => {
      if (j.id !== id) return j;
      const open = j.runs?.[0] && j.runs[0].code === undefined ? j.runs[0] : undefined;
      const done: RunRecord = { ...(open ?? { at: now }), code, ...(file ? { file } : {}) };
      return { ...j, lastCode: code, runs: [done, ...(j.runs ?? []).slice(open ? 1 : 0)].slice(0, MOST_RUNS) };
    }));
  }

  /** Remembers that a run started; `due` is when it should have, kept only when it is late. */
  markRun(id: string, at: number, due?: number): void {
    this.#save(this.list().map((j) => (j.id === id ? { ...j, lastRun: at, runs: [{ at, ...(due !== undefined && at - due > LATE_MS ? { due } : {}) }, ...(j.runs ?? [])].slice(0, MOST_RUNS) } : j)));
  }
  get exists(): boolean { return existsSync(this.path); }
}

/** Exactly one of cron, every and at, with `tz`: the fields to keep, or why not in words. */
function checkTiming(t: { cron?: string | undefined; every?: number | undefined; at?: number | undefined; tz?: string | undefined }): { cron: string; every?: number; at?: number; tz?: string } | string {
  const given = [t.cron?.trim() ? "cron" : "", t.every !== undefined ? "every" : "", t.at !== undefined ? "at" : ""].filter(Boolean);
  if (given.length !== 1) return "say when with one schedule: a cron of five fields, an interval, or one time";
  if (t.tz && !isTimeZone(t.tz)) return `"${t.tz}" is not a time zone`;
  const zone = t.tz ? { tz: t.tz } : {};
  if (t.every !== undefined) return t.every < SHORTEST_REPEAT_MS ? "a task may repeat at most once every 60 seconds" : { cron: "", every: t.every, ...zone };
  if (t.at !== undefined) return Number.isFinite(t.at) ? { cron: "", at: t.at, ...zone } : "that time is not valid";
  const parsed = parseCron(t.cron!);
  return typeof parsed === "string" ? parsed : { cron: t.cron!.trim(), ...zone };
}

const anchor = (j: Job): number => Math.max(j.lastRun ?? j.created, j.from ?? 0);

/** When a task was due since it last started, or none. It is the first time it should have started, so a task whose time came more than once while nothing ran starts once, not many times. */
export function dueAt(j: Job, now: number): number | undefined {
  if (j.disabled) return undefined;
  const from = anchor(j);
  if (j.at !== undefined) return j.at <= now && from < j.at ? j.at : undefined;
  if (j.every !== undefined) { const t = from + j.every; return t <= now ? t : undefined; }
  const c = parseCron(j.cron);
  return typeof c === "string" ? undefined : dueSince(c, from, now, j.tz);
}

/** When a task runs next; none while it is turned off, or when a one-time task has run. */
export function nextDue(j: Job, now: number): number | undefined {
  if (j.disabled) return undefined;
  if (j.at !== undefined) return anchor(j) < j.at ? j.at : undefined;
  if (j.every !== undefined) return anchor(j) + j.every;
  const c = parseCron(j.cron);
  return typeof c === "string" ? undefined : nextRun(c, now, j.tz);
}

const EVERY: [number, string][] = [[86_400_000, "d"], [3_600_000, "h"], [60_000, "m"], [1_000, "s"]];

/** The timing in a few words: the cron, "every 2h", or "once 2026-12-01 09:00 UTC". */
export function timingText(j: Job): string {
  if (j.every !== undefined) { const [size, unit] = EVERY.find(([n]) => j.every! % n === 0)!; return `every ${j.every / size}${unit}`; }
  if (j.at !== undefined) return `once ${new Date(j.at).toISOString().slice(0, 16).replace("T", " ")} UTC`;
  return j.cron;
}

/** Tasks whose time has come since they last ran. */
export function dueJobs(jobs: readonly Job[], now: number): Job[] {
  return jobs.filter((j) => dueAt(j, now) !== undefined);
}
