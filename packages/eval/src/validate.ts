import { rmSync } from "node:fs";
import type { Task } from "./task.ts";
import { applySolution, check, killProcesses, leftovers, missingPrograms, newSecret, prepare, protectedHashes, scriptEnv, shell } from "./workspace.ts";

export interface Validation { task: string; status: "ok" | "fail" | "skipped"; problems: string[] }

/**
 * A task is fit to measure with when it fails untouched, passes with its reference solution, the solution leaves the protected files
 * alone and leaves nothing running. A task that needs a program this computer lacks is skipped, never failed.
 */
export async function validateTask(task: Task): Promise<Validation> {
  const missing = missingPrograms(task);
  if (missing.length) return { task: task.id, status: "skipped", problems: [`needs ${missing.join(", ")}`] };
  const env = scriptEnv({ BENCH_SECRET: newSecret() });
  const dir = prepare(task);
  const problems: string[] = [];
  try {
    if (task.setup) { const r = await shell(dir, task.setup, env); if (!r.ok) problems.push(`its setup fails: ${r.output.trim().split("\n").at(-1) ?? ""}`); }
    if (!problems.length) {
      const before = protectedHashes(dir, task.protect);
      if ((await check(dir, task, 120_000, env)).ok) problems.push("passes before any change");
      try { await applySolution(dir, task, env); } catch (e) { problems.push(e instanceof Error ? e.message : String(e)); }
      if (!problems.length) {
        if (!(await check(dir, task, 120_000, env)).ok) problems.push("fails with its solution");
        if (JSON.stringify(Object.entries(before).sort()) !== JSON.stringify(Object.entries(protectedHashes(dir, task.protect)).sort())) problems.push("the solution changes protected files");
        const left = leftovers(dir);
        if (left.length) problems.push("the solution leaves a process running");
      }
    }
  } finally {
    killProcesses(leftovers(dir));
    if (task.teardown) await shell(dir, task.teardown, env).catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  }
  return { task: task.id, status: problems.length ? "fail" : "ok", problems };
}
