import type { ScheduleInfo } from "@navvied/protocol";
import type { Kit } from "./providers/kit.ts";
import { BAD_CRON, BAD_DATE, BAD_DAY, BAD_EVERY, BAD_TIME, DATES, EVERIES, MONTHDAYS, TIMES, WEEKDAYS, WHENS, cronWords, firstWhen, parseDay, parseEvery, parseTime, scheduleOf, subSteps, validDate, whenOf, type When } from "./schedule-when.ts";

export const SCHEDULE_FOOT = "Tasks run only while this computer is on and navvied is running.";
const MODES = [{ label: "Only read and plan", hint: "It looks and writes a plan. It changes nothing." }, { label: "Can change files", hint: "It may change files with nobody to ask. Your permission rules still apply." }];
const clock = (h: number, m: number): string => `${h}:${String(m).padStart(2, "0")}`;

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
    if (picked === items.length) { await wizard(k, undefined, now); continue; }
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
  else if (picked === 2) await wizard(k, j, now);
  else if (picked === 3 && (await k.choose(`Remove ${j.title}?`, `Remove ${j.title}?`, [{ label: "Keep it" }, { label: "Remove it" }])) === 1) await k.link.call("schedules", { cmd: "schedule.remove", id: j.id });
}

interface Typed { ask: string; valid: (text: string) => boolean; bad: string }

/** A list whose last row is typed (another time, another day…): the typed answer is checked, and a wrong one is asked again with the sentence that says what to use. Resolves to the row or the typed text, or undefined for Esc. */
async function pick(k: Kit, title: string, body: string[], rows: readonly string[], now: string, typed: Typed): Promise<string | undefined> {
  for (;;) {
    const picked = await k.choose(title, title, rows.map((label) => ({ label })), { at: Math.max(0, rows.indexOf(now)), body });
    if (picked === undefined) return undefined;
    if (picked < rows.length - 1) return rows[picked]!;
    for (;;) {
      const got = await k.text(title, k.frame("", typed.ask), "");
      if (got === undefined) break;
      if (typed.valid(got)) return got;
      k.note.push(typed.bad);
    }
  }
}

/** New task, or Change task: its name, what to do, when (and the questions that row needs), and what it may do, one question at a time; Esc goes back one. */
async function wizard(k: Kit, had: ScheduleInfo | undefined, now: () => number): Promise<void> {
  const title = had ? "Change task" : "New task";
  const f = { name: had?.title ?? "", what: had?.prompt ?? "", when: had ? whenOf(had) : firstWhen(), mode: had?.mode === "auto" ? 1 : 0 };
  let i = 0, dir = 1;
  for (;;) {
    const steps = ["name", "what", "when", ...subSteps(f.when.kind), "mode"] as const;
    if (i >= steps.length) return;
    const step = steps[i]!;
    const w: When = f.when;
    let back = false;
    if (step === "name") {
      const got = await k.text(title, k.frame("", "What should it be called?"), f.name);
      if (got === undefined) back = true;
      else if (!got) { k.note.push("Give it a name."); continue; }
      else f.name = got;
    } else if (step === "what") {
      const got = await k.text(title, k.frame("", "What should navvied do each time?"), f.what);
      if (got === undefined) back = true;
      else if (!got) { k.note.push("Say what it should do."); continue; }
      else f.what = got;
    } else if (step === "when") {
      const picked = await k.choose(title, title, WHENS.map((r) => ({ label: r.label, ...(r.hint ? { hint: r.hint } : {}) })), { at: w.kind, body: ["When should it run?"] });
      if (picked === undefined) back = true; else w.kind = picked;
    } else if (step === "weekday") {
      const picked = await k.choose(title, title, WEEKDAYS.map((label) => ({ label })), { at: w.weekday, body: ["On which day?"] });
      if (picked === undefined) back = true; else w.weekday = picked;
    } else if (step === "monthday") {
      const got = await pick(k, title, ["On which day of the month?"], MONTHDAYS, MONTHDAYS.find((m) => parseDay(m) === parseDay(w.monthday)) ?? "", { ask: "Which day, 1 to 31?", valid: (t) => parseDay(t) !== undefined, bad: BAD_DAY });
      if (got === undefined) back = true; else w.monthday = got;
    } else if (step === "date") {
      const got = await pick(k, title, ["On which day?"], DATES, DATES.find((d) => d.toLowerCase() === w.date.toLowerCase()) ?? "", { ask: "Which date?", valid: (t) => validDate(t, now()), bad: BAD_DATE });
      if (got === undefined) back = true; else w.date = got;
    } else if (step === "time") {
      const got = await pick(k, title, ["At what time?", k.dim(WHENS[w.kind]!.label.replace("…", ""))], TIMES, w.time, { ask: "At what time?", valid: (t) => parseTime(t) !== undefined, bad: BAD_TIME });
      if (got === undefined) back = true; else w.time = got;
    } else if (step === "every") {
      const got = await pick(k, title, ["How often?", k.dim("Every…")], EVERIES, w.every, { ask: "How many minutes or hours?", valid: (t) => parseEvery(t) !== undefined, bad: BAD_EVERY });
      if (got === undefined) back = true; else w.every = got;
    } else if (step === "cron") {
      const got = await k.text(title, k.frame("", "Write the schedule", k.dim("Five fields: minute, hour, day, month, weekday.")), w.cron);
      if (got === undefined) back = true;
      else if (got.split(/\s+/).filter(Boolean).length !== 5) { k.note.push(BAD_CRON); w.cron = got; continue; }
      else w.cron = got;
    } else {
      const picked = await k.choose(title, title, MODES, { at: f.mode, body: ["What may it do?"] });
      if (picked === undefined) back = true;
      else {
        f.mode = picked;
        const when = scheduleOf(w, now());
        if (typeof when === "string") { k.note.push(when); i = 2; dir = -1; continue; }
        const input = { title: f.name, ...when, prompt: f.what, mode: f.mode ? "auto" : "plan" };
        const done = await k.link.call("schedules", had ? { cmd: "schedule.update", id: had.id, ...input } : { cmd: "schedule.add", ...input });
        if (typeof done === "string") { k.note.push(done); i = 2; dir = -1; continue; }
        k.note.push("Task saved.");
        return;
      }
    }
    if (back && i === 0) return;
    dir = back ? -1 : 1;
    i += dir;
  }
}
