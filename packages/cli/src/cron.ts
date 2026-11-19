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

/** Whether the expression names this minute (local time). Like cron: when both day fields are restricted, either one matching is enough. */
export function matches(c: Cron, at: Date): boolean {
  if (!c.minute.has(at.getMinutes()) || !c.hour.has(at.getHours()) || !c.month.has(at.getMonth() + 1)) return false;
  const day = c.dom.has(at.getDate()), week = c.dow.has(at.getDay());
  return c.domAny || c.dowAny ? day && week : day || week;
}

/** The next minute after `after` that the expression names (local time), looking up to a year ahead; none when there is not one. Walks day by day. */
export function nextRun(c: Cron, after: number): number | undefined {
  const first = new Date(Math.floor(after / 60_000) * 60_000 + 60_000);
  const hours = [...c.hour].sort((a, b) => a - b), minutes = [...c.minute].sort((a, b) => a - b);
  for (let d = 0; d <= 400; d++) {
    const day = new Date(first.getFullYear(), first.getMonth(), first.getDate() + d);
    const dom = c.dom.has(day.getDate()), dow = c.dow.has(day.getDay());
    if (!c.month.has(day.getMonth() + 1) || !(c.domAny || c.dowAny ? dom && dow : dom || dow)) continue;
    for (const h of hours) for (const m of minutes) {
      const t = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m).getTime();
      if (t >= first.getTime()) return t;
    }
  }
  return undefined;
}

/** The first minute after `after`, up to and including `now`, that the expression names; none when there is not one. Looks back at most a week. */
export function dueSince(c: Cron, after: number, now: number): number | undefined {
  const start = Math.max(after, now - 7 * 86_400_000);
  for (let t = Math.floor(start / 60_000) * 60_000 + 60_000; t <= now; t += 60_000) if (matches(c, new Date(t))) return t;
  return undefined;
}
