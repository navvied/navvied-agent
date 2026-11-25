import type { ScheduleInfo } from "@navvied/protocol";

/** The rows of "When should it run?", in the words of the page. */
export const WHENS: readonly { label: string; hint?: string }[] = [
  { label: "Every day" }, { label: "Every weekday" }, { label: "Every week on…" }, { label: "Every month on…" }, { label: "Once at…" }, { label: "Every few minutes or hours" },
  { label: "Write it myself", hint: "For people who know the five-field form." },
];
export const TIMES = ["6:00", "9:00", "12:00", "18:00", "22:00", "Another time"] as const;
export const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;
export const MONTHDAYS = ["The 1st", "The 15th", "Another day"] as const;
export const DATES = ["Today", "Tomorrow", "Another date"] as const;
export const EVERIES = ["5 minutes", "15 minutes", "30 minutes", "Hour", "2 hours", "6 hours", "Another number"] as const;

export const BAD_TIME = "Use a time such as 9:30.";
export const BAD_CRON = "Use five fields, such as 0 9 * * 1-5.";
export const BAD_DAY = "Use a day from 1 to 31.";
export const BAD_DATE = "Use a date such as 2026-12-01.";
export const BAD_EVERY = "Use up to 59 minutes or 23 hours, such as 20 minutes.";
export const PAST = "That time has passed.";

/** What the person chose, one field for each question that can be asked. `kind` is the row of WHENS. */
export interface When { kind: number; time: string; weekday: number; monthday: string; date: string; every: string; cron: string }
export const firstWhen = (): When => ({ kind: 1, time: "9:00", weekday: 0, monthday: "1", date: "Tomorrow", every: "30 minutes", cron: "" });

/** The questions after "When", in order, for a row. */
export const subSteps = (kind: number): ("time" | "weekday" | "monthday" | "date" | "every" | "cron")[] =>
  kind <= 1 ? ["time"] : kind === 2 ? ["weekday", "time"] : kind === 3 ? ["monthday", "time"] : kind === 4 ? ["date", "time"] : kind === 5 ? ["every"] : ["cron"];

export const parseTime = (s: string): { h: number; m: number } | undefined => {
  const at = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  const h = at ? Number(at[1]) : NaN, m = at ? Number(at[2]) : NaN;
  return h >= 0 && h < 24 && m >= 0 && m < 60 ? { h, m } : undefined;
};
export const parseDay = (s: string): number | undefined => {
  const n = Number(/^The (\d+)/.exec(s)?.[1] ?? (/^\d{1,2}$/.test(s.trim()) ? s.trim() : NaN));
  return Number.isInteger(n) && n >= 1 && n <= 31 ? n : undefined;
};
export const parseEvery = (s: string): { minutes: number } | { hours: number } | undefined => {
  const t = s.trim().toLowerCase();
  if (t === "hour") return { hours: 1 };
  const x = /^(\d+)\s*(min(?:ute)?s?|h(?:our)?s?)$/.exec(t);
  if (!x) return undefined;
  const n = Number(x[1]);
  return x[2]!.startsWith("m") ? (n >= 1 && n <= 59 ? { minutes: n } : undefined) : n >= 1 && n <= 23 ? { hours: n } : undefined;
};
const parseDate = (s: string, now: number): Date | undefined => {
  const t = s.trim().toLowerCase(), base = new Date(now);
  if (t === "today") return new Date(base.getFullYear(), base.getMonth(), base.getDate());
  if (t === "tomorrow") return new Date(base.getFullYear(), base.getMonth(), base.getDate() + 1);
  const x = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (!x) return undefined;
  const d = new Date(Number(x[1]), Number(x[2]) - 1, Number(x[3]));
  return d.getMonth() === Number(x[2]) - 1 ? d : undefined;
};
export const validDate = (s: string, now: number): boolean => parseDate(s, now) !== undefined;

/** What `schedule.add` takes for the choices: a cron line, or one moment, or the sentence that says what to change. */
export function scheduleOf(w: When, now: number): { cron: string } | { at: number } | string {
  const time = parseTime(w.time);
  if (w.kind === 6) return w.cron.trim().split(/\s+/).filter(Boolean).length === 5 ? { cron: w.cron.trim().split(/\s+/).join(" ") } : BAD_CRON;
  if (w.kind === 5) {
    const e = parseEvery(w.every);
    return !e ? BAD_EVERY : "minutes" in e ? { cron: `*/${e.minutes} * * * *` } : e.hours === 1 ? { cron: "@hourly" } : { cron: `0 */${e.hours} * * *` };
  }
  if (!time) return BAD_TIME;
  if (w.kind <= 1) return { cron: `${time.m} ${time.h} * * ${w.kind === 0 ? "*" : "1-5"}` };
  if (w.kind === 2) return { cron: `${time.m} ${time.h} * * ${(w.weekday + 1) % 7}` };
  if (w.kind === 3) { const d = parseDay(w.monthday); return d === undefined ? BAD_DAY : { cron: `${time.m} ${time.h} ${d} * *` }; }
  const date = parseDate(w.date, now);
  if (!date) return BAD_DATE;
  const at = new Date(date.getFullYear(), date.getMonth(), date.getDate(), time.h, time.m).getTime();
  return at > now ? { at } : PAST;
}

const clock = (h: number, m: number): string => `${h}:${String(m).padStart(2, "0")}`;
const nth = (n: number): string => `the ${n}${n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th"}`;

/** A cron line in the words of the page ("Every weekday at 9:00"), or the line itself when it is not one of the ordinary ones. */
export function cronWords(cron: string): string {
  if (cron === "@hourly" || cron === "0 * * * *") return "Every hour";
  if (cron === "@daily") return "Every day at 0:00";
  const every = /^\*\/(\d+) \* \* \* \*$/.exec(cron) ?? undefined;
  if (every) return `Every ${every[1]} minutes`;
  const hours = /^0 \*\/(\d+) \* \* \*$/.exec(cron);
  if (hours) return `Every ${hours[1]} hours`;
  const f = /^(\d{1,2}) (\d{1,2}) (\S+) \* (\S+)$/.exec(cron);
  if (!f) return cron;
  const at = clock(Number(f[2]), Number(f[1]));
  if (f[3] === "*" && f[4] === "*") return `Every day at ${at}`;
  if (f[3] === "*" && f[4] === "1-5") return `Every weekday at ${at}`;
  if (f[3] === "*" && /^[0-7]$/.test(f[4]!)) return `Every ${WEEKDAYS[(Number(f[4]) + 6) % 7]} at ${at}`;
  if (/^\d{1,2}$/.test(f[3]!) && f[4] === "*" && Number(f[3]) >= 1 && Number(f[3]) <= 31) return `Every month on ${nth(Number(f[3]))} at ${at}`;
  return cron;
}

/** The choices that give back a task's schedule, so it can be changed from where it stands. */
export function whenOf(job: ScheduleInfo): When {
  const w = firstWhen();
  const cron = job.cron;
  const f = /^(\d{1,2}) (\d{1,2}) (\S+) \* (\S+)$/.exec(cron);
  const every = /^\*\/(\d+) \* \* \* \*$/.exec(cron), hours = /^0 \*\/(\d+) \* \* \*$/.exec(cron);
  if (every) return { ...w, kind: 5, every: `${every[1]} minutes` };
  if (hours) return { ...w, kind: 5, every: `${hours[1]} hours` };
  if (cron === "@hourly" || cron === "0 * * * *") return { ...w, kind: 5, every: "Hour" };
  if (f) {
    const time = clock(Number(f[2]), Number(f[1]));
    if (f[3] === "*" && f[4] === "*") return { ...w, kind: 0, time };
    if (f[3] === "*" && f[4] === "1-5") return { ...w, kind: 1, time };
    if (f[3] === "*" && /^[0-7]$/.test(f[4]!)) return { ...w, kind: 2, time, weekday: (Number(f[4]) + 6) % 7 };
    if (/^\d{1,2}$/.test(f[3]!) && f[4] === "*") return { ...w, kind: 3, time, monthday: f[3]! };
  }
  return { ...w, kind: 6, cron };
}
