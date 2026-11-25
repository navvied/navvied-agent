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
  case "pulse": {
    ok = jobs.length === 1 && named("pulse")[0]?.every === MIN;
    break;
  }
  default: console.error("unknown check", process.argv[2]);
}
process.exit(ok ? 0 : 1);
