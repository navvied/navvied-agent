import { isTimeZone } from "../cron.ts";
import { redact } from "../redact.ts";
import { scanPrompt } from "../text-scan.ts";
import { parseWhen } from "../schedule-when.ts";
import type { ScheduleBackend, ScheduleJob, ScheduleRun, Tool } from "../types.ts";
import { clip, str } from "./util.ts";

export const MOST_PROMPT = 4_000;
const MOST_NAME = 80;
const ACTIONS = ["list", "create", "update", "pause", "resume", "remove", "runs", "run", "cancel"] as const;
type Action = (typeof ACTIONS)[number];

const stamp = (ms: number, tz?: string): string => {
  if (!tz) { const d = new Date(ms), p = (n: number): string => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())} local`; }
  const parts: Record<string, string> = {};
  for (const x of new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(ms)) parts[x.type] = x.value;
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} ${tz}`;
};

const jobLine = (j: ScheduleJob): string => `${j.id} "${j.name}": ${j.when}${j.tz ? ` ${j.tz}` : ""}, mode ${j.mode}${j.enabled ? "" : ", paused"}${j.enabled && j.next !== undefined ? `, next ${stamp(j.next, j.tz)}` : ""}${j.lastOutcome ? `, last ${j.lastOutcome}${j.lastAt !== undefined ? ` ${stamp(j.lastAt, j.tz)}` : ""}` : ""}`;
const runLine = (r: ScheduleRun, tz?: string): string => `${stamp(r.at, tz)} ${r.outcome}${r.due !== undefined ? ` (missed: it was due ${stamp(r.due, tz)} and started late)` : ""}${r.note ? `: ${r.note}` : ""}`;

/** The job a person or model means: by id, by name, or by the start of an id. */
function find(jobs: readonly ScheduleJob[], ref: string): ScheduleJob | string {
  const r = ref.trim().toLowerCase();
  const hit = r ? jobs.find((j) => j.id.toLowerCase() === r) ?? jobs.find((j) => j.name.toLowerCase() === r) ?? (jobs.filter((j) => j.id.toLowerCase().startsWith(r)).length === 1 ? jobs.find((j) => j.id.toLowerCase().startsWith(r)) : undefined) : undefined;
  if (hit) return hit;
  return `There is no job "${ref}".${jobs.length ? ` The jobs are: ${jobs.map((j) => `${j.id} "${j.name}"`).join(", ")}.` : " There are no jobs yet."}`;
}

/** The refusal for a prompt that tries to steer the model, or nothing. */
const suspicious = (prompt: string): string | undefined => {
  const found = scanPrompt(prompt);
  return found.length ? `Not saved: the prompt has ${found.join(" and ")}. A job's prompt says what to do, in plain words.` : undefined;
};

const problem = (text: string): string => `Error: ${text}`;
const sentence = (text: string): string => (/[.!?]$/.test(text) ? text : `${text}.`);

export const schedule: Tool = {
  name: "Schedule",
  readOnly: false,
  // Not offered to a small model: it is named in the prompt, and a call is run.
  offeredWhen: ({ small, schedule }) => !small && schedule === true,
  description: "Run a task later or on a timetable, with nobody to ask. create needs prompt and when: \"every 2h\", \"every monday 9am\", \"tomorrow at 9\" or cron. run starts a job now, cancel stops it. A job only reads and plans unless mode is auto.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: [...ACTIONS] },
      id: { type: "string", description: "job id or name" },
      name: { type: "string" },
      prompt: { type: "string" },
      when: { type: "string" },
      tz: { type: "string", description: "e.g. Asia/Jakarta" },
      mode: { type: "string", enum: ["plan", "auto"] },
    },
    required: ["action"],
  },
  fixArgs: (a) => {
    const when = a.when ?? a.schedule ?? a.cron ?? a.at ?? a.every ?? a.time;
    return { ...a, when, id: a.id ?? a.job ?? a.job_id, tz: a.tz ?? a.timezone ?? a.time_zone, action: a.action ?? a.op ?? (a.prompt || when ? (a.id ? "update" : "create") : "list") };
  },
  title: (a) => `${str(a.action) || "list"} scheduled job ${str(a.name) || str(a.id)}${str(a.when) ? ` (${str(a.when)})` : ""}${a.mode === "auto" ? ", allowed to change things when it runs" : ""}`.replace(/\s+/g, " ").trim(),
  async run(a, ctx) {
    const backend: ScheduleBackend | undefined = ctx.schedule;
    if (!backend) return problem("jobs cannot be scheduled here.");
    const action = str(a.action) as Action;
    if (!ACTIONS.includes(action)) return problem(`action is one of ${ACTIONS.join(", ")}. Example: {"action":"list"}`);
    if (action !== "list" && action !== "runs" && !backend.canChange) return problem("Not allowed: a job that is running cannot change the jobs.");

    const jobs = await backend.list();
    if (typeof jobs === "string") return problem(sentence(jobs));
    const say = (r: string): string => redact(clip(r, 8_000));
    if (action === "list") return say(jobs.length ? jobs.map(jobLine).join("\n") : "There are no jobs yet.");

    const mode: "plan" | "auto" | null | undefined = a.mode === undefined ? undefined : a.mode === "auto" || a.mode === "plan" ? a.mode : null;
    if (mode === null) return problem('mode is "plan" (read only) or "auto".');
    if (mode === "auto" && ctx.untrusted === true) return problem("Not allowed: this turn has read text from the web, so a job that may change things needs the person's own request. Make it with mode plan, or ask the person.");

    if (action === "create") {
      const prompt = str(a.prompt).trim(), name = str(a.name).trim() || prompt.replace(/\s+/g, " ").slice(0, 40);
      if (!prompt) return problem('a job needs a prompt: what to do each time. Example: {"action":"create","prompt":"summarise yesterday\'s commits","when":"daily at 09:00"}');
      if (prompt.length > MOST_PROMPT) return problem(`The prompt may be at most ${MOST_PROMPT} characters.`);
      const bad = suspicious(prompt);
      if (bad) return problem(bad);
      if (name.length > MOST_NAME) return problem(`The name may be at most ${MOST_NAME} characters.`);
      if (backend.maxJobs !== undefined && jobs.length >= backend.maxJobs) return problem(`At most ${backend.maxJobs} jobs are kept. Remove one first.`);
      const tz = str(a.tz).trim() || undefined;
      if (tz && !isTimeZone(tz)) return problem(`"${tz}" is not a time zone. Use a name such as "Asia/Jakarta" or "UTC".`);
      if (!str(a.when).trim()) return problem('say when: "in 20 minutes", "every 2h", "daily at 09:00", or a cron of five fields.');
      const timing = parseWhen(str(a.when), { now: backend.now(), ...(tz ? { zone: tz } : {}) });
      if (typeof timing === "string") return problem(timing);
      const made = await backend.create({ name, prompt, timing, mode: mode ?? "plan", ...(tz ? { tz } : {}) });
      return typeof made === "string" ? problem(sentence(made)) : say(`Created ${jobLine(made)}. ${backend.about}`);
    }

    const job = find(jobs, str(a.id) || str(a.name));
    if (typeof job === "string") return problem(job);
    if (action === "remove") { const done = await backend.remove(job.id); return done === true ? `Removed ${job.id} "${job.name}".` : problem(sentence(done)); }
    if (action === "run" || action === "cancel") {
      const done = await (action === "run" ? backend.run(job.id) : backend.cancel(job.id));
      return done === true ? `${action === "run" ? `Started ${job.id} "${job.name}". Its result is in runs.` : `Stopped ${job.id} "${job.name}".`}` : problem(sentence(done));
    }
    if (action === "pause" || action === "resume") {
      const done = await backend.setEnabled(job.id, action === "resume");
      return typeof done === "string" ? problem(sentence(done)) : say(jobLine(done));
    }
    if (action === "runs") {
      const runs = await backend.runs(job.id);
      return typeof runs === "string" ? problem(sentence(runs)) : say(runs.length ? runs.map((r) => runLine(r, job.tz)).join("\n") : `${job.id} has not run yet.`);
    }

    const prompt = a.prompt === undefined ? undefined : str(a.prompt).trim();
    if (prompt !== undefined && !prompt) return problem("a job needs a prompt: what to do each time.");
    if (prompt && prompt.length > MOST_PROMPT) return problem(`The prompt may be at most ${MOST_PROMPT} characters.`);
    const bad = prompt ? suspicious(prompt) : undefined;
    if (bad) return problem(bad);
    const tz = str(a.tz).trim() || undefined;
    if (tz && !isTimeZone(tz)) return problem(`"${tz}" is not a time zone. Use a name such as "Asia/Jakarta" or "UTC".`);
    const timing = a.when === undefined ? undefined : parseWhen(str(a.when), { now: backend.now(), ...((tz ?? job.tz) ? { zone: (tz ?? job.tz)! } : {}) });
    if (typeof timing === "string") return problem(timing);
    const name = str(a.name).trim();
    if (name.length > MOST_NAME) return problem(`The name may be at most ${MOST_NAME} characters.`);
    const change = { ...(name ? { name } : {}), ...(prompt ? { prompt } : {}), ...(timing ? { timing } : {}), ...(tz ? { tz } : {}), ...(mode ? { mode } : {}) };
    if (!Object.keys(change).length) return problem("say what to change: name, prompt, when, tz or mode.");
    const done = await backend.update(job.id, change);
    return typeof done === "string" ? problem(sentence(done)) : say(`Changed ${jobLine(done)}`);
  },
};
