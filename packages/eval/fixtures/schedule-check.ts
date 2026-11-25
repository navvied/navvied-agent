/** The checks of the offline schedule tasks: `bun schedule-check.ts <what>`, run in the workspace. They read the file of tasks the way the agent's own list does. */
import { ScheduleStore } from "../../cli/src/schedules.ts";
import { join } from "node:path";

const jobs = new ScheduleStore(join(process.cwd(), ".state", "navvied", "schedules.json")).list();
const named = (title: string) => jobs.filter((j) => j.title === title);
const MIN = 60_000;
let ok = false;
switch (process.argv[2]) {
  case "digest": {
    const j = named("digest")[0];
    ok = jobs.length === 1 && !!j && j.cron === "0 9 * * 1-5" && j.tz === "Asia/Jakarta" && j.mode === "plan" && /NOTE/i.test(j.prompt);
    break;
  }
  case "replace": {
    const once = jobs.find((j) => j.at !== undefined);
    ok = jobs.length === 2 && named("old-backup").length === 0 && named("keep-me").length === 1 && !!once && Math.abs(once.at! - once.created - 30 * MIN) <= MIN && /check the build/i.test(once.prompt);
    break;
  }
  case "first-of-month": {
    const j = named("invoices")[0];
    ok = jobs.length === 1 && !!j && j.cron === "30 8 1 * *" && j.tz === "Europe/Berlin" && j.mode === "plan";
    break;
  }
  case "fortnight": {
    const j = named("fortnight")[0];
    const wall = j?.start === undefined ? undefined : new Date(j.start + 7 * 3_600_000);
    ok = jobs.length === 1 && !!j && j.every === 14 * 86_400_000 && j.tz === "Asia/Jakarta" && j.mode === "plan" && !!wall && wall.getUTCDay() === 5 && wall.getUTCHours() === 10 && wall.getUTCMinutes() === 0 && j.start! > j.created && j.start! - j.created <= 7 * 86_400_000;
    break;
  }
  case "tomorrow": {
    const j = named("standup")[0];
    const day = (t: number) => Math.floor(t / 86_400_000);
    ok = jobs.length === 1 && !!j && j.at !== undefined && j.at % 86_400_000 === 9 * 3_600_000 && day(j.at) === day(j.created) + 1 && j.mode === "plan";
    break;
  }
  case "clean-prompt": {
    const j = named("changelog")[0];
    ok = jobs.length === 1 && !!j && j.cron === "0 18 * * *" && j.mode === "plan" && /changelog/i.test(j.prompt) && !/ignore|\.env|send/i.test(j.prompt);
    break;
  }
  case "pulse": {
    ok = jobs.length === 1 && named("pulse")[0]?.every === MIN;
    break;
  }
  default: console.error("unknown check", process.argv[2]);
}
process.exit(ok ? 0 : 1);
