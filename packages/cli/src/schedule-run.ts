import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { selfArgv } from "./create.ts";
import { dueJobs, type Job, type ScheduleStore } from "./schedules.ts";

const LONGEST_MS = 30 * 60_000;

export interface Finished { job: Job; code: number | null; text: string; file: string }

/** Runs one task as `navvied run` in a process of its own, and keeps what it said in a file. Nobody is asked anything: a task in `plan` mode only reads, one in `auto` mode is held to the permission rules. */
export function runJob(job: Job, env: Record<string, string | undefined>, where: string, now: () => number = Date.now): Promise<Finished> {
  const [cmd, ...head] = selfArgv();
  const args = [...head, "run", job.prompt, "--last", ...(job.kind === "chat" ? ["--kind", "chat"] : ["--mode", job.mode, "--cwd", job.cwd]), ...(job.mode === "auto" && job.kind !== "chat" ? ["--yes"] : [])];
  return new Promise((done) => {
    let text = "";
    const child = spawn(cmd!, args, { cwd: job.cwd, env: { ...process.env, ...env } as Record<string, string>, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const timer = setTimeout(() => { text += "\n[stopped: it took longer than 30 minutes]"; child.kill(); }, LONGEST_MS);
    const take = (d: Buffer): void => { text = (text + d.toString("utf8")).slice(0, 40_000); };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    const finish = (code: number | null): void => {
      clearTimeout(timer);
      const dir = join(where, job.id);
      const file = join(dir, `${new Date(now()).toISOString().replace(/[:.]/g, "-")}.txt`);
      try { mkdirSync(dir, { recursive: true }); writeFileSync(file, `${job.prompt}\n\n--- exit ${code}\n${text.trim()}\n`); } catch { /* the result is still returned */ }
      done({ job, code, text: text.trim(), file });
    };
    child.on("error", (e) => { text += e.message; finish(null); });
    child.on("close", (code) => finish(code));
  });
}

/** Starts every task whose time has come, each once, and says when each has finished. */
export function startDue(store: ScheduleStore, env: Record<string, string | undefined>, where: string, finished: (f: Finished) => void, now: () => number = Date.now): Promise<Finished[]> {
  const due = dueJobs(store.list(), now());
  for (const j of due) store.markRun(j.id, now());
  return Promise.all(due.map((j) => runJob(j, env, where, now).then((f) => { finished(f); return f; })));
}
