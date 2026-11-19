import { resolve } from "node:path";
import type { Options } from "../args.ts";
import { scheduledDir, schedulesPath } from "../config.ts";
import { parseCron } from "../cron.ts";
import type { IO } from "../io.ts";
import { runJob, startDue } from "../schedule-run.ts";
import { ScheduleStore } from "../schedules.ts";
import { EXIT } from "./run.ts";

const USAGE = `usage:
  navvied schedule add "<minute hour day month weekday>" <task>   e.g. navvied schedule add "0 9 * * 1-5" "summarise yesterday's commits"
                       [--mode auto] [--cwd <folder>]             (without --mode it only reads and plans)
  navvied schedule list
  navvied schedule remove <id>
  navvied schedule run <id>      run one now
  navvied schedule run-due       run what is due, once, and exit (for the system's own timer: cron, launchd, systemd)
Tasks run while navvied is open, or when run-due is called. A task that was due while nothing ran starts once, at the next chance.`;

export async function scheduleCommand(rest: string | undefined, options: Options, io: IO): Promise<number> {
  const store = new ScheduleStore(schedulesPath(io.env));
  const words = (rest ?? "").trim().split(/\s+/).filter(Boolean);
  const sub = words.shift();
  const say = (text: string): void => { io.stdout.write(`${text}\n`); };

  if (sub === "list" || sub === undefined) {
    const jobs = store.list();
    if (!jobs.length) { say(sub === undefined ? USAGE : "No scheduled tasks."); return sub === undefined ? EXIT.usage : EXIT.ok; }
    for (const j of jobs) say(`${j.id}  ${j.cron.padEnd(14)} ${j.mode.padEnd(5)} ${j.prompt.slice(0, 60)}${j.prompt.length > 60 ? "…" : ""}  (${j.cwd})`);
    return EXIT.ok;
  }
  if (sub === "add") {
    const first = words[0] ?? "";
    const parts = first.startsWith("@") ? words.splice(0, 1) : words.splice(0, 5);
    const cron = parts.join(" ");
    if (typeof parseCron(cron) === "string") { io.stderr.write(`error: ${parseCron(cron) as string}\n`); return EXIT.usage; }
    const made = store.add({ cron, prompt: words.join(" "), cwd: resolve(options.cwd ?? process.cwd()), ...(options.mode === "auto" ? { mode: "auto" as const } : {}) });
    if (typeof made === "string") { io.stderr.write(`error: ${made}\n`); return EXIT.usage; }
    say(`Scheduled ${made.id}: ${made.cron} (${made.mode}) in ${made.cwd}`);
    return EXIT.ok;
  }
  if (sub === "remove") {
    const id = words[0] ?? "";
    if (!store.remove(id)) { io.stderr.write(`error: there is no task "${id}"\n`); return EXIT.failed; }
    say(`Removed ${id}.`);
    return EXIT.ok;
  }
  if (sub === "run") {
    const job = store.list().find((j) => j.id === words[0]);
    if (!job) { io.stderr.write(`error: there is no task "${words[0] ?? ""}"\n`); return EXIT.failed; }
    const f = await runJob(job, io.env, scheduledDir(io.env));
    say(f.text); say(`(kept in ${f.file})`);
    return f.code === 0 ? EXIT.ok : EXIT.failed;
  }
  if (sub === "run-due") {
    const done = await startDue(store, io.env, scheduledDir(io.env), (f) => say(`${f.job.id}: ${f.code === 0 ? "done" : `failed (exit ${f.code})`}, kept in ${f.file}`));
    if (!done.length) say("Nothing is due.");
    return done.every((f) => f.code === 0) ? EXIT.ok : EXIT.failed;
  }
  io.stderr.write(`error: unknown schedule command "${sub}"\n${USAGE}\n`);
  return EXIT.usage;
}
