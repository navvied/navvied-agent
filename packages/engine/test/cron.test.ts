import { describe, expect, test } from "bun:test";
import { cronMatches, isTimeZone, nextRun, parseCron } from "../src/cron.ts";

const cron = (text: string) => { const c = parseCron(text); if (typeof c === "string") throw new Error(c); return c; };
const iso = (t: number | undefined) => (t === undefined ? undefined : new Date(t).toISOString());

describe("a schedule in a named time zone", () => {
  test("names a zone it knows and refuses one it does not", () => {
    expect(isTimeZone("Asia/Jakarta")).toBe(true);
    expect(isTimeZone("UTC")).toBe(true);
    expect(isTimeZone("Mars/Olympus")).toBe(false);
  });

  test("09:00 in Jakarta is 02:00 in UTC, and the next one is the next morning once today's has passed", () => {
    const c = cron("0 9 * * *");
    expect(iso(nextRun(c, Date.parse("2026-11-25T00:00:00Z"), "Asia/Jakarta"))).toBe("2026-11-25T02:00:00.000Z");
    expect(iso(nextRun(c, Date.parse("2026-11-25T02:00:00Z"), "Asia/Jakarta"))).toBe("2026-11-26T02:00:00.000Z");
    expect(iso(nextRun(c, Date.parse("2026-11-25T00:00:00Z"), "UTC"))).toBe("2026-11-25T09:00:00.000Z");
  });

  test("the same wall time keeps its meaning across a change of clocks", () => {
    const c = cron("30 9 * * *");
    expect(iso(nextRun(c, Date.parse("2026-03-07T12:00:00Z"), "America/New_York"))).toBe("2026-03-07T14:30:00.000Z");
    expect(iso(nextRun(c, Date.parse("2026-03-08T15:00:00Z"), "America/New_York"))).toBe("2026-03-09T13:30:00.000Z");
    expect(iso(nextRun(c, Date.parse("2026-03-08T12:00:00Z"), "America/New_York"))).toBe("2026-03-08T13:30:00.000Z");
  });

  test("a wall time the clocks skip is left out that day, and one they repeat is named once, at its first turn", () => {
    expect(iso(nextRun(cron("30 2 * * *"), Date.parse("2026-03-08T00:00:00Z"), "America/New_York"))).toBe("2026-03-09T06:30:00.000Z");
    const repeated = cron("30 1 * * *");
    const first = nextRun(repeated, Date.parse("2026-11-01T00:00:00Z"), "America/New_York");
    expect(iso(first)).toBe("2026-11-01T05:30:00.000Z");
    expect(iso(nextRun(repeated, first!, "America/New_York"))).toBe("2026-11-02T06:30:00.000Z");
  });

  test("days of the week and of the month are read in the zone, not in UTC", () => {
    const monday = cron("0 0 * * 1");
    expect(iso(nextRun(monday, Date.parse("2026-11-25T00:00:00Z"), "Asia/Jakarta"))).toBe("2026-11-29T17:00:00.000Z");
    expect(cronMatches(cron("0 6 * * 4"), new Date("2026-11-25T23:00:00Z"), "Asia/Jakarta")).toBe(true);
    expect(cronMatches(cron("0 6 * * 4"), new Date("2026-11-25T23:00:00Z"), "UTC")).toBe(false);
  });

  test("with no zone it is still the runtime's own time, as before", () => {
    const c = cron("0 9 * * *");
    const t = nextRun(c, Date.now())!;
    expect(new Date(t).getHours()).toBe(9);
    expect(new Date(t).getMinutes()).toBe(0);
  });
});
