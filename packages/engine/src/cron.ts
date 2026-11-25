/** A cron expression: minute hour day-of-month month day-of-week, each `*`, a number, a range `a-b`, a list `a,b`, or a step (a slash and a number after `*` or after a range). */
export interface Cron { minute: Set<number>; hour: Set<number>; dom: Set<number>; month: Set<number>; dow: Set<number>; domAny: boolean; dowAny: boolean }

const FIELDS: { name: string; min: number; max: number }[] = [
  { name: "minute", min: 0, max: 59 }, { name: "hour", min: 0, max: 23 }, { name: "day of the month", min: 1, max: 31 }, { name: "month", min: 1, max: 12 }, { name: "day of the week", min: 0, max: 7 },
];
const SHORT: Record<string, string> = { "@hourly": "0 * * * *", "@daily": "0 0 * * *", "@midnight": "0 0 * * *", "@weekly": "0 0 * * 0", "@monthly": "0 0 1 * *", "@yearly": "0 0 1 1 *", "@annually": "0 0 1 1 *" };

function field(text: string, spec: { name: string; min: number; max: number }): Set<number> | string {
  const out = new Set<number>();
  for (const part of text.split(",")) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!m) return `"${part}" is not a valid ${spec.name}`;
    const step = m[2] ? Number(m[2]) : 1;
    if (step < 1) return `the step in "${part}" must be at least 1`;
    let from = spec.min, to = spec.max;
    if (m[1] !== "*") {
      const [a, b] = m[1]!.split("-").map(Number) as [number, number | undefined];
      from = a; to = b ?? (m[2] ? spec.max : a);
    }
    if (from < spec.min || to > spec.max || from > to) return `"${part}" is outside ${spec.min} to ${spec.max} for the ${spec.name}`;
    for (let v = from; v <= to; v += step) out.add(v);
  }
  return out;
}

/** Reads an expression, or says in words what is wrong with it. */
export function parseCron(expression: string): Cron | string {
  const text = SHORT[expression.trim().toLowerCase()] ?? expression.trim();
  const parts = text.split(/\s+/);
  if (parts.length !== 5) return "a schedule has five parts: minute hour day-of-month month day-of-week (for example \"0 9 * * 1-5\" is 09:00 on weekdays)";
  const sets: Set<number>[] = [];
  for (const [i, p] of parts.entries()) { const s = field(p, FIELDS[i]!); if (typeof s === "string") return s; sets.push(s); }
  const dow = new Set([...sets[4]!].map((d) => d % 7));
  return { minute: sets[0]!, hour: sets[1]!, dom: sets[2]!, month: sets[3]!, dow, domAny: parts[2]!.startsWith("*"), dowAny: parts[4]!.startsWith("*") };
}

const formats = new Map<string, Intl.DateTimeFormat>();
const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Whether `zone` names a time zone this runtime knows (an IANA name such as "Asia/Jakarta"). */
export function isTimeZone(zone: string): boolean {
  try { new Intl.DateTimeFormat("en-US", { timeZone: zone }); return true; } catch { return false; }
}

interface Wall { year: number; month: number; day: number; hour: number; minute: number; dow: number }

/** The wall clock of an instant: in `zone`, or in the runtime's own time when there is none. */
function wall(t: number, zone?: string): Wall {
  if (!zone) { const d = new Date(t); return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(), hour: d.getHours(), minute: d.getMinutes(), dow: d.getDay() }; }
  let f = formats.get(zone);
  if (!f) { f = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", weekday: "short" }); formats.set(zone, f); }
  const p: Record<string, string> = {};
  for (const part of f.formatToParts(t)) p[part.type] = part.value;
  return { year: Number(p.year), month: Number(p.month), day: Number(p.day), hour: Number(p.hour), minute: Number(p.minute), dow: WEEKDAYS[p.weekday!] ?? 0 };
}

/** The instant whose wall clock in `zone` reads this; none when that time does not exist there (the hour a clock skips forward). */
function instantOf(zone: string, year: number, month: number, day: number, hour: number, minute: number): number | undefined {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const offsetAt = (t: number): number => { const w = wall(t, zone); return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute) - Math.floor(t / 60_000) * 60_000; };
  let t = guess - offsetAt(guess);
  t = guess - offsetAt(t);
  const w = wall(t, zone);
  return w.year === year && w.month === month && w.day === day && w.hour === hour && w.minute === minute ? t : undefined;
}

const dayMatches = (c: Cron, day: number, dow: number): boolean => { const d = c.dom.has(day), w = c.dow.has(dow); return c.domAny || c.dowAny ? d && w : d || w; };

/** Whether the expression names this minute, in `zone` (the runtime's own time when none). Like cron: when both day fields are restricted, either one matching is enough. */
export function cronMatches(c: Cron, at: Date, zone?: string): boolean {
  const w = wall(at.getTime(), zone);
  return c.minute.has(w.minute) && c.hour.has(w.hour) && c.month.has(w.month) && dayMatches(c, w.day, w.dow);
}

/** The next minute after `after` that the expression names, in `zone` (the runtime's own time when none), looking up to a year ahead; none when there is not one. Walks day by day. */
export function nextRun(c: Cron, after: number, zone?: string): number | undefined {
  const first = Math.floor(after / 60_000) * 60_000 + 60_000;
  const hours = [...c.hour].sort((a, b) => a - b), minutes = [...c.minute].sort((a, b) => a - b);
  const start = wall(first, zone);
  for (let d = 0; d <= 400; d++) {
    const day = new Date(Date.UTC(start.year, start.month - 1, start.day + d));
    const year = day.getUTCFullYear(), month = day.getUTCMonth() + 1, date = day.getUTCDate();
    if (!c.month.has(month) || !dayMatches(c, date, day.getUTCDay())) continue;
    for (const h of hours) for (const m of minutes) {
      const t = zone ? instantOf(zone, year, month, date, h, m) : new Date(year, month - 1, date, h, m).getTime();
      if (t !== undefined && t >= first) return t;
    }
  }
  return undefined;
}

/** The first minute after `after`, up to and including `now`, that the expression names; none when there is not one. Looks back at most a week. */
export function dueSince(c: Cron, after: number, now: number, zone?: string): number | undefined {
  const start = Math.max(after, now - 7 * 86_400_000);
  for (let t = Math.floor(start / 60_000) * 60_000 + 60_000; t <= now; t += 60_000) if (cronMatches(c, new Date(t), zone)) return t;
  return undefined;
}
