import { instantOf, parseCron, wall } from "./cron.ts";

/** When a job runs: on a cron expression, every so often (counted from its last run), or once. */
export type Timing =
  | { kind: "cron"; cron: string }
  /** `start` is the first start; later ones keep to its grid (every 2 weeks on friday). */
  | { kind: "every"; ms: number; start?: number }
  | { kind: "at"; at: number };

export const SHORTEST_REPEAT_MS = 60_000;

const UNITS: Record<string, number> = { s: 1_000, sec: 1_000, second: 1_000, m: 60_000, min: 60_000, minute: 60_000, h: 3_600_000, hr: 3_600_000, hour: 3_600_000, d: 86_400_000, day: 86_400_000, w: 604_800_000, week: 604_800_000 };
const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const FORMS = 'Say when as "in 20 minutes", "tomorrow at 9", "2026-12-01 09:00", "every 2h", "daily at 09:00", "weekdays at 8:30", "every monday 9am", "every 2 weeks on friday", "first of the month" or a cron of five fields such as "0 9 * * 1-5".';
const WEEK_MS = 604_800_000;
/** The time of day when the words give none. */
const DEFAULT_TIME = { h: 9, m: 0 };
const DAY = "(?:sun|mon|tue|wed|thu|fri|sat)[a-z]*";
const DAY_LIST = new RegExp(`^${DAY}(?:(?:, and |, ?| and | & )${DAY})*$`);

type Time = { h: number; m: number };
type Where = { now: number; zone?: string | undefined };

const unitMs = (word: string): number | undefined => UNITS[word] ?? UNITS[word.replace(/s$/, "")];
const dayOf = (word: string): number => (word.length < 3 ? -1 : DAYS.findIndex((d) => d.startsWith(word) || d.startsWith(word.replace(/s$/, ""))));

/** "monday and thursday" as the cron's day field ("1,4"), or none when it is not a list of days. */
function dayList(text: string): string | undefined {
  if (!DAY_LIST.test(text)) return undefined;
  const days = text.split(/, and |, ?| and | & /).map(dayOf);
  return days.includes(-1) ? undefined : [...new Set(days)].sort((a, b) => a - b).join(",");
}

/** "9", "09:30", "9pm", "noon": the hour and minute, or why not. */
function clock(text: string): Time | string {
  const t = text.trim();
  if (t === "noon") return { h: 12, m: 0 };
  if (t === "midnight") return { h: 0, m: 0 };
  const x = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(t);
  if (!x) return `"${text}" is not a time of day. Use a form like 09:00 or 9pm.`;
  let h = Number(x[1]);
  const m = Number(x[2] ?? 0);
  if (x[3]) { if (h < 1 || h > 12) return `"${text}" is not a time of day.`; h = (h % 12) + (x[3] === "pm" ? 12 : 0); }
  return h > 23 || m > 59 ? `"${text}" is not a time of day.` : { h, m };
}

/** The instant a wall-clock time has in `zone` (this computer's own time when none), or why there is none. */
function instant(zone: string | undefined, y: number, mo: number, d: number, h: number, mi: number): number | string {
  const t = zone ? instantOf(zone, y, mo, d, h, mi) : new Date(y, mo - 1, d, h, mi).getTime();
  return t === undefined ? `That time does not exist in ${zone} (the clock skips that hour).` : t;
}

/** An exact time as written: with an offset it is that instant, without one it is the wall clock of `zone` (this computer's own time when none). */
function exact(text: string, zone: string | undefined): number | string {
  const x = /^(\d{4})-(\d{2})-(\d{2})(?:[t ](\d{2}):(\d{2})(?::(\d{2}))?)?\s*(z|[+-]\d{2}:?\d{2})?$/.exec(text);
  if (!x) return FORMS;
  if (x[4] === undefined) return `Give the time of day too, for example "${text} 09:00".`;
  const [y, mo, d, h, mi] = [Number(x[1]), Number(x[2]), Number(x[3]), Number(x[4]), Number(x[5])] as [number, number, number, number, number];
  const real = mo >= 1 && mo <= 12 && h <= 23 && mi <= 59 && new Date(Date.UTC(y, mo - 1, d)).getUTCDate() === d;
  if (!real) return `"${text}" is not a real date and time.`;
  if (x[7]) {
    const t = Date.parse(`${x[1]}-${x[2]}-${x[3]}T${x[4]}:${x[5]}:${x[6] ?? "00"}${x[7] === "z" ? "Z" : x[7].replace(/^([+-]\d{2})(\d{2})$/, "$1:$2")}`);
    return Number.isNaN(t) ? `"${text}" is not a real date and time.` : t;
  }
  return instant(zone, y, mo, d, h, mi);
}

/** The time of day `k` days from today, in the zone of the words, and the weekday of that day. */
function dayAt(k: number, t: Time, o: Where): { at: number | string; dow: number } {
  const w = wall(o.now, o.zone), d = new Date(Date.UTC(w.year, w.month - 1, w.day + k));
  return { at: instant(o.zone, d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), t.h, t.m), dow: d.getUTCDay() };
}

/** The next time of day that falls on this weekday after now (not today when `skipToday`). */
function nextDay(dow: number, t: Time, o: Where, skipToday = false): number | string {
  for (let k = skipToday ? 1 : 0; k <= 7; k++) {
    const d = dayAt(k, t, o);
    if (d.dow === dow && (typeof d.at === "string" || d.at > o.now)) return d.at;
  }
  return FORMS;
}

/** Reads what a person or a model wrote for "when", or says in one plain sentence what to write instead. `now` is the clock, `zone` the time zone that wall-clock words are in. */
export function parseWhen(input: string, o: { now: number; zone?: string }): Timing | string {
  const text = input.trim().toLowerCase().replace(/\s+/g, " ");

  const later = /^in (\d+(?:\.\d+)?) ?([a-z]+)$/.exec(text);
  if (later) {
    const unit = unitMs(later[2]!);
    if (unit && Number(later[1]) * unit >= 1) return { kind: "at", at: o.now + Math.round(Number(later[1]) * unit) };
    return unit ? "That time is not in the future." : FORMS;
  }

  const every = /^every (?:(\d+(?:\.\d+)?) ?)?([a-z]+)$/.exec(text);
  const unit = every ? unitMs(every[2]!) : undefined;
  if (every && unit) {
    const ms = Math.round(Number(every[1] ?? 1) * unit);
    return ms < SHORTEST_REPEAT_MS ? "A job may repeat at most once every 60 seconds." : { kind: "every", ms };
  }

  if (text === "hourly") return { kind: "cron", cron: "0 * * * *" };

  if (/^\d{4}-/.test(text)) {
    const at = exact(text, o.zone);
    return typeof at === "string" ? at : at > o.now ? { kind: "at", at } : "That time has already passed.";
  }

  if (text.startsWith("@") || /^[\d*,/-]+( [\d*,/-]+)+$/.test(text)) {
    const cron = parseCron(text);
    return typeof cron === "string" ? cron : { kind: "cron", cron: text };
  }

  const split = /^(.*?) (?:at |@ ?)?(\d{1,2}(?::\d{2})? ?(?:am|pm)?|noon|midnight)$/.exec(text);
  const head = split ? split[1]! : text;
  const t = split ? clock(split[2]!) : DEFAULT_TIME;
  if (typeof t === "string") return t;
  const cron = (days: string, dom = "*"): Timing => ({ kind: "cron", cron: `${t.m} ${t.h} ${dom} * ${days}` });

  if (/^(daily|every ?day)$/.test(head)) return cron("*");
  if (/^(weekdays|every weekday)$/.test(head)) return cron("1-5");
  if (/^(weekends|every weekend)$/.test(head)) return cron("0,6");

  const prefixed = /^(?:weekly on|every) (.+)$/.exec(head);
  const list = dayList(prefixed ? prefixed[1]! : /s$/.test(head) ? head : "");
  if (list !== undefined) return cron(list);

  const weeks = /^every (\d+|other) weeks? on (.+)$/.exec(head);
  if (weeks && dayList(weeks[2]!) !== undefined && !weeks[2]!.includes(",") && !weeks[2]!.includes(" ")) {
    const n = weeks[1] === "other" ? 2 : Number(weeks[1]), day = dayOf(weeks[2]!);
    if (n < 1) return FORMS;
    if (n === 1) return cron(String(day));
    const first = nextDay(day, t, o);
    return typeof first === "string" ? first : { kind: "every", ms: n * WEEK_MS, start: first };
  }

  const month = /^(?:(?:monthly|every month|each month)(?: on the (\d{1,2})(?:st|nd|rd|th)?)?|(?:on )?the (\d{1,2})(?:st|nd|rd|th)(?: of (?:the|every|each) month)?|(?:the )?(first) of (?:the|every|each) month)$/.exec(head);
  if (month) {
    const dom = month[3] ? 1 : Number(month[1] ?? month[2] ?? 1);
    return dom >= 1 && dom <= 31 ? cron("*", String(dom)) : "A day of the month is 1 to 31.";
  }

  const days = { today: 0, tomorrow: 1, "day after tomorrow": 2 } as Record<string, number>;
  const once = /^(?:(next|on) )?(.+)$/.exec(head);
  const one = days[head] !== undefined ? onDay(days[head]!, t, o) : once && DAY_LIST.test(once[2]!) && dayOf(once[2]!) >= 0 ? nextDay(dayOf(once[2]!), t, o, once[1] === "next") : undefined;
  if (one === undefined) return FORMS;
  return typeof one === "string" ? one : one > o.now ? { kind: "at", at: one } : "That time has already passed.";
}

const onDay = (k: number, t: Time, o: Where): number | string => dayAt(k, t, o).at;
