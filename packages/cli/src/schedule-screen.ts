import type { EngineEvent, ScheduleInfo } from "@navvied/protocol";
import type { Kit } from "./providers/kit.ts";

type Schedules = Extract<EngineEvent, { ev: "schedules" }>;

export const SCHEDULE_FOOT = "Tasks run only while this computer is on and navvied is running.";
const WHENS = ["Every day", "Every weekday", "Every hour", "Every week", "Every month", "My own time"] as const;
const TIMES = ["6:00", "9:00", "12:00", "18:00", "22:00", "My own time"] as const;
const MODES = [{ label: "Only read and plan", hint: "It looks and writes a plan. It changes nothing." }, { label: "Can change files", hint: "It may change files with nobody to ask. Your permission rules still apply." }];
const OWN = "My own time";
const clock = (h: number, m: number): string => `${h}:${String(m).padStart(2, "0")}`;

const DAYS: Record<string, string> = { "Every day": "* * *", "Every weekday": "* * 1-5", "Every week": "* * 1", "Every month": "1 * *" };

/** The cron line for what the person chose, or nothing when the time is not a time of day. */
function cronOf(when: string, time: string, own: string): string | undefined {
  if (when === OWN) return own;
  if (when === "Every hour") return "@hourly";
  const at = /^(\d{1,2}):(\d{2})$/.exec(time);
  const h = at ? Number(at[1]) : NaN, m = at ? Number(at[2]) : NaN;
  return h >= 0 && h < 24 && m >= 0 && m < 60 ? `${m} ${h} ${DAYS[when]}` : undefined;
}

/** A cron line in the words of the page ("every weekday at 9:00"), or the line itself when it is not one of the ordinary ones. */
export function cronWords(cron: string): string {
  if (cron === "@hourly" || cron === "0 * * * *") return "every hour";
  if (cron === "@daily") return "every day at 0:00";
  const f = /^(\d{1,2}) (\d{1,2}) (\S+) \* (\S+)$/.exec(cron);
  if (!f) return cron;
  const at = clock(Number(f[2]), Number(f[1]));
  if (f[3] === "*" && f[4] === "*") return `every day at ${at}`;
  if (f[3] === "*" && f[4] === "1-5") return `every weekday at ${at}`;
  if (f[3] === "*" && f[4] === "1") return `every week at ${at}`;
  if (f[3] === "1" && f[4] === "*") return `every month at ${at}`;
  return cron;
}

/** The choices that give back a cron line, so a task can be changed from where it stands. */
function formOf(cron: string): { when: string; time: string; own: string } {
  const words = cronWords(cron);
  const hit = WHENS.find((w) => words.startsWith(w.toLowerCase()) && w !== OWN);
  const time = /at (\d{1,2}:\d{2})$/.exec(words)?.[1] ?? "";
  return hit ? { when: hit, time: hit === "Every hour" ? "" : time, own: "" } : { when: OWN, time: "9:00", own: cron };
}

/** "today 9:00", "yesterday 16:00", "Monday 9:00": the day as a person says it, then the time. */
function day(ms: number, now: number): string {
  const d = new Date(ms), t = new Date(now);
  const start = (x: Date): number => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const gap = Math.round((start(d) - start(t)) / 86_400_000);
  const at = clock(d.getHours(), d.getMinutes());
  if (gap === 0) return `today ${at}`;
  if (gap === 1) return `tomorrow ${at}`;
  if (gap === -1) return `yesterday ${at}`;
  return `${Math.abs(gap) < 7 ? d.toLocaleDateString("en-US", { weekday: "long" }) : d.toLocaleDateString("en-US", { day: "numeric", month: "short" })} ${at}`;
}

const lastWords = (j: ScheduleInfo, now: number): string => (j.last === undefined || j.lastCode === undefined || j.lastCode === null ? "Not run yet" : j.lastCode === 0 ? `Ran fine ${day(j.last, now)}` : `Last run failed ${day(j.last, now)}`);

/** One task as a row: on or off and its name, then when it runs and how the last run went. */
function row(j: ScheduleInfo, now: number): { label: string; hint: string } {
  const next = j.enabled ? `next ${j.next === undefined ? "none" : day(j.next, now)}` : "off";
  return { label: `${j.enabled ? "on " : "off"}  ${j.title}`, hint: `${cronWords(j.cron)}, ${next}, ${lastWords(j, now)}${j.mode === "auto" ? ", can change files" : ""}` };
}

/** `/schedule`: the tasks and what can be done with one. Resolves when the person goes back out of the list. */
export async function scheduleScreen(k: Kit, now: () => number = Date.now): Promise<void> {
  let at = 0;
  for (;;) {
    const got = await k.link.call("schedules", { cmd: "schedules" });
    if (typeof got === "string") { k.say(got); return; }
    const items = got.items;
    const empty = !items.length;
    const rows = [...items.map((j) => row(j, now())), { label: "New task" }];
    const body = empty ? [k.dim("No tasks yet."), k.dim("A task is something navvied does for you at a time you choose."), k.dim(SCHEDULE_FOOT)] : [k.dim(SCHEDULE_FOOT)];
    const picked = await k.choose("Schedule", "Schedule", rows, { at: Math.min(at, rows.length - 1), body });
    if (picked === undefined) return;
    at = picked;
    if (picked === items.length) { await wizard(k, undefined); continue; }
    await task(k, items[picked]!, now);
  }
}

/** One task: run it now, turn it on or off, change it, or remove it. */
async function task(k: Kit, j: ScheduleInfo, now: () => number): Promise<void> {
  const rows = [
    { label: "Run now" },
    j.enabled ? { label: "Turn it off", hint: "It stays in the list and does not run." } : { label: "Turn it on", hint: "It runs at the next time above." },
    { label: "Change it" },
    { label: "Remove it" },
  ];
  const next = j.next === undefined ? "none while off" : day(j.next, now());
  const picked = await k.choose(j.title, j.title, rows, { body: [k.dim(`${cronWords(j.cron)}, next ${next}`)] });
  if (picked === 0) { k.link.send({ cmd: "schedule.run", id: j.id }); k.note.push("Started."); }
  else if (picked === 1) await k.link.call("schedules", { cmd: "schedule.update", id: j.id, enabled: !j.enabled });
  else if (picked === 2) await wizard(k, j);
  else if (picked === 3 && (await k.choose(`Remove ${j.title}?`, `Remove ${j.title}?`, [{ label: "Keep it" }, { label: "Remove it" }])) === 1) await k.link.call("schedules", { cmd: "schedule.remove", id: j.id });
}

/** New task, or Change task: its name, what to do, when, at what time, and what it may do, one question at a time; Esc goes back one. */
async function wizard(k: Kit, had: ScheduleInfo | undefined): Promise<void> {
  const title = had ? "Change task" : "New task";
  const was = had ? formOf(had.cron) : { when: "Every weekday", time: "9:00", own: "" };
  const f = { name: had?.title ?? "", what: had?.prompt ?? "", when: was.when, time: was.time, own: was.own, mode: had?.mode === "auto" ? 1 : 0 };
  const steps = ["name", "what", "when", "time", "mode"] as const;
  let i = 0, dir = 1;
  while (i < steps.length) {
    const step = steps[i]!;
    // An hourly task and one with its own cron line have no time of day to ask for.
    if (step === "time" && (f.when === "Every hour" || f.when === OWN)) { i += dir; continue; }
    let back = false;
    if (step === "name") {
      const got = await k.text(title, k.frame("", "What should it be called?"), f.name);
      if (got === undefined) back = true; else f.name = got;
    } else if (step === "what") {
      const got = await k.text(title, k.frame("", "What should navvied do each time?"), f.what);
      if (got === undefined) back = true;
      else if (!got) { k.note.push("Say what navvied should do each time."); continue; }
      else f.what = got;
    } else if (step === "when") {
      const picked = await k.choose(title, title, WHENS.map((label) => ({ label })), { at: Math.max(0, WHENS.indexOf(f.when as (typeof WHENS)[number])), body: ["When should it run?"] });
      if (picked === undefined) back = true;
      else {
        f.when = WHENS[picked]!;
        if (f.when === OWN) {
          const own = await k.text(title, k.frame("", "Write it as five fields: minute, hour, day, month, weekday.", k.dim("For example: 0 9 * * 1-5")), f.own);
          if (own === undefined) continue;
          f.own = own;
        }
      }
    } else if (step === "time") {
      const picked = await k.choose(title, title, TIMES.map((label) => ({ label })), { at: Math.max(0, TIMES.indexOf(f.time as (typeof TIMES)[number])), body: ["At what time?", k.dim(f.when)] });
      if (picked === undefined) back = true;
      else if (TIMES[picked] === OWN) {
        const own = await k.text(title, k.frame("", "At what time?", k.dim("For example: 7:30")), "");
        if (own === undefined) continue;
        f.time = own;
      } else f.time = TIMES[picked]!;
    } else {
      const picked = await k.choose(title, title, MODES, { at: f.mode, body: ["What may it do?"] });
      if (picked === undefined) back = true;
      else {
        f.mode = picked;
        const cron = cronOf(f.when, f.time, f.own);
        if (cron === undefined) { k.note.push("Write the time like 7:30."); i = steps.indexOf("time"); dir = -1; continue; }
        const input = { title: f.name || "New task", cron, prompt: f.what, mode: f.mode ? "auto" : "plan" };
        const done = await k.link.call("schedules", had ? { cmd: "schedule.update", id: had.id, ...input } : { cmd: "schedule.add", ...input });
        if (typeof done === "string") { k.note.push(done); i = steps.indexOf("when"); dir = -1; continue; }
        k.note.push("Task saved.");
        return;
      }
    }
    if (back && i === 0) return;
    dir = back ? -1 : 1;
    i += dir;
  }
}
