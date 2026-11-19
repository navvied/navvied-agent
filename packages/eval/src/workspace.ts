import { mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
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

const SCRIPT = "apply.sh";

/** The reference solution: its files laid over the workspace, then its `apply.sh` run (for tasks whose solution is actions, such as starting a server). */
export async function applySolution(dir: string, task: Task, env: Record<string, string> = {}): Promise<void> {
  const files = solutionFiles(task);
  const script = files[SCRIPT];
  delete files[SCRIPT];
  write(dir, files);
  if (script !== undefined) {
    const r = await shell(dir, script, env, 300_000);
    if (!r.ok) throw new Error(`${task.id}: the solution's ${SCRIPT} failed: ${r.output.trim().split("\n").at(-1) ?? ""}`);
  }
}

/** A random value for one run, in the environment of the setup, the agent and the check: an answer that holds it was made in this run. */
export const newSecret = (): string => crypto.randomUUID().replaceAll("-", "").slice(0, 16);

/** The programs a task needs that this computer does not have. */
export const missingPrograms = (task: Task): string[] => task.requires.filter((p) => !Bun.which(p));

/** Processes, other than this one, that run in the workspace or were started from it. Where processes cannot be listed (not Linux) nothing is found. */
export function leftovers(dir: string): number[] {
  if (process.platform !== "linux") return [];
  const found: number[] = [];
  for (const name of readdirSync("/proc")) {
    const pid = Number(name);
    if (!Number.isInteger(pid) || pid === process.pid) continue;
    try {
      const cwd = readlinkSync(`/proc/${pid}/cwd`);
      if (cwd === dir || cwd.startsWith(`${dir}/`) || readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(dir)) found.push(pid);
    } catch { /* gone, or not ours to look at */ }
  }
  return found;
}

export function killProcesses(pids: number[]): void {
  for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
}

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

/** A shell command in the workspace; `ok` when it exits with 0. */
export async function shell(dir: string, command: string, env: Record<string, string> = {}, timeoutMs = 120_000): Promise<CheckResult> {
  const started = Date.now();
  const p = Bun.spawn(process.platform === "win32" ? ["cmd.exe", "/d", "/s", "/c", command] : ["bash", "-c", command], { cwd: dir, env: { ...process.env, ...env }, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: timeoutMs });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { ok: (await p.exited) === 0, output: `${out}${err}`.slice(-4000), ms: Date.now() - started };
}

export const check = (dir: string, task: Task, timeoutMs = 120_000, env: Record<string, string> = {}): Promise<CheckResult> => shell(dir, task.check, env, timeoutMs);
