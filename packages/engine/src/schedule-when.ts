import { instantOf, parseCron } from "./cron.ts";

/** When a job runs: on a cron expression, every so often (counted from its last run), or once. */
export type Timing = { kind: "cron"; cron: string } | { kind: "every"; ms: number } | { kind: "at"; at: number };

export const SHORTEST_REPEAT_MS = 60_000;

const UNITS: Record<string, number> = { s: 1_000, sec: 1_000, second: 1_000, m: 60_000, min: 60_000, minute: 60_000, h: 3_600_000, hr: 3_600_000, hour: 3_600_000, d: 86_400_000, day: 86_400_000, w: 604_800_000, week: 604_800_000 };
const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const FORMS = 'Say when as "in 20 minutes", "2026-12-01 09:00", "every 2h", "daily at 09:00", "weekdays at 9:00", "weekly on monday at 09:00" or a cron of five fields such as "0 9 * * 1-5".';

const unitMs = (word: string): number | undefined => UNITS[word] ?? UNITS[word.replace(/s$/, "")];
const dayOf = (word: string): number => DAYS.findIndex((d) => d === word || d.slice(0, 3) === word);

/** "9", "09:30", "9pm": the hour and minute, or why not. */
function clock(text: string): { h: number; m: number } | string {
  const x = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(text.trim());
  if (!x) return `"${text}" is not a time of day. Use a form like 09:00 or 9pm.`;
  let h = Number(x[1]);
  const m = Number(x[2] ?? 0);
  if (x[3]) { if (h < 1 || h > 12) return `"${text}" is not a time of day.`; h = (h % 12) + (x[3] === "pm" ? 12 : 0); }
  return h > 23 || m > 59 ? `"${text}" is not a time of day.` : { h, m };
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
  const t = zone ? instantOf(zone, y, mo, d, h, mi) : new Date(y, mo - 1, d, h, mi).getTime();
  return t === undefined ? `"${text}" does not exist in ${zone} (the clock skips that hour).` : t;
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
  const dated = /^(daily|every day|weekdays|every weekday|weekly on ([a-z]+)|every ([a-z]+)|([a-z]+)s)(?: at (.+))?$/.exec(text);
  if (dated) {
    const word = dated[2] ?? dated[3] ?? dated[4];
    const days = /^(daily|every day)$/.test(dated[1]!) ? "*" : /^(weekdays|every weekday)$/.test(dated[1]!) ? "1-5" : word !== undefined && dayOf(word) >= 0 ? String(dayOf(word)) : undefined;
    if (days !== undefined) {
      if (dated[5] === undefined) return `Say the time of day too, for example "${text} at 09:00".`;
      const t = clock(dated[5]);
      return typeof t === "string" ? t : { kind: "cron", cron: `${t.m} ${t.h} * * ${days}` };
    }
  }

  if (/^\d{4}-/.test(text)) {
    const at = exact(text, o.zone);
    return typeof at === "string" ? at : at > o.now ? { kind: "at", at } : "That time has already passed.";
  }

  if (text.startsWith("@") || /^[\d*,/-]+( [\d*,/-]+)+$/.test(text)) {
    const cron = parseCron(text);
    return typeof cron === "string" ? cron : { kind: "cron", cron: text };
  }
  return FORMS;
}
