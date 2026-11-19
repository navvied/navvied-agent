import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { repoFiles, solutionFiles, type Task } from "./task.ts";

const write = (dir: string, files: Record<string, string>): void => {
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
};

const git = (cwd: string, ...args: string[]): void => {
  const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed`);
};

/** A fresh workspace: the task's starting files in a new git repository with one commit. */
export function prepare(task: Task): string {
  const dir = mkdtempSync(join(tmpdir(), `navvied-eval-${task.id}-`));
  write(dir, repoFiles(task));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "eval@navvied.invalid");
  git(dir, "config", "user.name", "eval");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "start");
  return dir;
}

export const applySolution = (dir: string, task: Task): void => write(dir, solutionFiles(task));

export function protectedHashes(dir: string, patterns: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pattern of patterns) {
    for (const file of new Bun.Glob(pattern).scanSync({ cwd: dir, onlyFiles: true })) {
      // Keyed the same on every system: the scan gives Windows paths with backslashes.
      out[file.replaceAll(sep, "/")] = new Bun.CryptoHasher("sha256").update(readFileSync(join(dir, file))).digest("hex");
    }
  }
  return out;
}

export interface CheckResult { ok: boolean; output: string; ms: number }

export async function check(dir: string, task: Task, timeoutMs = 120_000): Promise<CheckResult> {
  const started = Date.now();
  const p = Bun.spawn(process.platform === "win32" ? ["cmd.exe", "/d", "/s", "/c", task.check] : ["bash", "-c", task.check], { cwd: dir, stdout: "pipe", stderr: "pipe", timeout: timeoutMs });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { ok: (await p.exited) === 0, output: `${out}${err}`.slice(-4000), ms: Date.now() - started };
}
