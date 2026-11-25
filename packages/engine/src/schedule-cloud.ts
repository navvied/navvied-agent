import { askService } from "./tools/web-proxy.ts";
import type { Timing } from "./schedule-when.ts";
import type { ScheduleBackend, ScheduleInput, ScheduleJob, ScheduleRun, WebProxy } from "./types.ts";

interface CloudJob { id: string; name: string; prompt: string; cron: string; tz: string; mode: "plan" | "auto"; enabled: boolean; next?: number; lastOutcome?: ScheduleJob["lastOutcome"]; lastAt?: number; runs?: { at: number; outcome: ScheduleRun["outcome"]; note?: string }[] }

const job = (j: CloudJob): ScheduleJob => ({ id: j.id, name: j.name, prompt: j.prompt, when: j.cron, tz: j.tz, mode: j.mode, enabled: j.enabled, ...(j.next !== undefined ? { next: j.next } : {}), ...(j.lastOutcome ? { lastOutcome: j.lastOutcome } : {}), ...(j.lastAt !== undefined ? { lastAt: j.lastAt } : {}) });

/** Cloud jobs follow a cron schedule only: an interval that fits the clock becomes one, anything else is said plainly. */
export function cronOfTiming(t: Timing): { cron: string } | string {
  if (t.kind === "cron") return { cron: t.cron };
  if (t.kind === "at") return "Cloud jobs repeat on a cron schedule, so one that runs once is not available there. Give a cron such as \"0 9 * * *\", or make it a job on the computer.";
  const minutes = t.ms / 60_000;
  if (Number.isInteger(minutes) && minutes < 60 && 60 % minutes === 0) return { cron: `*/${minutes} * * * *` };
  const hours = minutes / 60;
  if (Number.isInteger(hours) && hours <= 24 && 24 % hours === 0) return { cron: hours === 24 ? "0 0 * * *" : `0 */${hours} * * *` };
  return "Cloud jobs follow a cron schedule, so that interval cannot be kept. Use one that divides the day, such as every 2h, or say it as a cron.";
}

/** The cloud's own jobs of a hosted session, over `POST /v1/schedule` on the session's grant (the web proxy's address and token). */
export class CloudSchedule implements ScheduleBackend {
  readonly about = "It runs in the cloud as a session of its own and keeps what it said as a conversation.";
  readonly canChange = true;
  readonly #url: string;

  constructor(private readonly proxy: WebProxy, readonly now: () => number = Date.now) {
    this.#url = `${proxy.url.replace(/\/+$/, "").replace(/\/web$/, "")}/schedule`;
  }

  async #ask(body: object): Promise<{ jobs?: CloudJob[]; job?: CloudJob; removed?: string } | string> {
    const got = await askService<{ jobs?: CloudJob[]; job?: CloudJob; removed?: string }>(this.#url, this.proxy.token, body, AbortSignal.timeout(20_000), "cloud jobs service");
    return got.ok ? got.value : got.message;
  }

  async list(): Promise<ScheduleJob[] | string> {
    const got = await this.#ask({ action: "list" });
    return typeof got === "string" ? got : (got.jobs ?? []).map(job);
  }

  async #one(body: object): Promise<ScheduleJob | string> {
    const got = await this.#ask(body);
    return typeof got === "string" ? got : got.job ? job(got.job) : "The cloud gave no answer.";
  }

  async create(i: ScheduleInput): Promise<ScheduleJob | string> {
    const cron = cronOfTiming(i.timing);
    return typeof cron === "string" ? cron : this.#one({ action: "create", name: i.name, prompt: i.prompt, ...cron, ...(i.tz ? { tz: i.tz } : {}), mode: i.mode });
  }

  async update(id: string, c: Partial<ScheduleInput>): Promise<ScheduleJob | string> {
    const cron = c.timing ? cronOfTiming(c.timing) : {};
    return typeof cron === "string" ? cron : this.#one({ action: "update", id, ...(c.name ? { name: c.name } : {}), ...(c.prompt ? { prompt: c.prompt } : {}), ...cron, ...(c.tz ? { tz: c.tz } : {}), ...(c.mode ? { mode: c.mode } : {}) });
  }

  setEnabled(id: string, enabled: boolean): Promise<ScheduleJob | string> { return this.#one({ action: enabled ? "resume" : "pause", id }); }

  async remove(id: string): Promise<true | string> {
    const got = await this.#ask({ action: "remove", id });
    return typeof got === "string" ? got : true;
  }

  async runs(id: string): Promise<ScheduleRun[] | string> {
    const got = await this.#ask({ action: "list" });
    if (typeof got === "string") return got;
    return (got.jobs?.find((j) => j.id === id)?.runs ?? []).map((r) => ({ at: r.at, outcome: r.outcome, ...(r.note ? { note: r.note } : {}) }));
  }
}
