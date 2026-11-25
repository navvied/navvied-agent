import { mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { gitEnv } from "../../engine/src/git-env.ts";
import { findChrome } from "../../engine/src/tools/browser.ts";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { dirname, join, sep, win32 } from "node:path";
import { repoFiles, solutionFiles, type Task } from "./task.ts";

/** A file that starts with `#!` is a program: it is made executable, as it would be in a checkout of the project. */
const write = (dir: string, files: Record<string, string>): void => {
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text, text.startsWith("#!") ? { mode: 0o755 } : {});
  }
};

const git = (cwd: string, ...args: string[]): void => {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: gitEnv(), stdout: "pipe", stderr: "pipe" });
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

/** Where the fixtures of the tasks live (the fixture web and the scripts that start and stop it). Setup, the solution, the check and the teardown know it; the agent does not. */
export const FIXTURES = join(import.meta.dir, "..", "fixtures");

/** The environment of a task's own scripts: this run's secret and the fixtures. */
export const scriptEnv = (secret: Record<string, string>): Record<string, string> => ({ ...secret, BENCH_FIXTURES: FIXTURES });

/**
  * The configuration of an agent for a task that declares MCP servers, hooks, stand-ins for media programs or other agents to ask, in a folder of its own outside the workspace: the agent starts each
 * server itself, runs each hook, from this file, and stops the servers when the run ends. `NAVVIED_CONFIG` points at it, so the person's own configuration is
 * never read or written. For other agents to ask, their address is the port the setup left in the workspace `where`, and their path. Nothing is written for a task with none of them.
 */
export function agentConfig(task: Task, where?: string): { env: Record<string, string>; remove(): void } {
  if (!task.mcp && !task.hooks && !task.media?.length && !task.a2a) return { env: {}, remove: () => undefined };
  const dir = mkdtempSync(join(tmpdir(), "navvied-eval-config-"));
  const mcp = task.mcp ? Object.fromEntries(Object.entries(task.mcp).map(([name, s]) => [name, { command: process.execPath, args: [join(FIXTURES, s.fixture)] }])) : undefined;
  const hooks = Object.fromEntries(Object.entries(task.hooks ?? {}).map(([event, list]) => [event, list.map((h) => ({ ...(h.matcher ? { matcher: h.matcher } : {}), command: `"${process.execPath.replaceAll("\\", "/")}" "${join(FIXTURES, h.fixture).replaceAll("\\", "/")}"` }))]));
  const program = (name: string): string => join(FIXTURES, "media", name);
  const engines = { stt: { bin: program("whisper-cli"), model: program("model.bin") }, tts: { bin: program("piper"), model: program("model.bin") }, image: { bin: program("sd"), model: program("model.bin") } };
  const media = task.media?.length ? { ...Object.fromEntries(task.media.map((k) => [k, engines[k]])), ffmpeg: program("ffmpeg") } : undefined;
  const port = where && existsSync(join(where, ".bench-port")) ? readFileSync(join(where, ".bench-port"), "utf8").trim() : "";
  const peers = task.a2a ? Object.fromEntries(Object.entries(task.a2a).map(([name, path]) => [name, { url: `http://127.0.0.1:${port}${path}` }])) : undefined;
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify({ models: {}, guestModels: false, ...(mcp ? { mcp } : {}), ...(task.hooks ? { hooks } : {}), ...(media ? { media } : {}), ...(peers ? { a2a: { peers } } : {}) }), { mode: 0o600 });
  return { env: { NAVVIED_CONFIG: path }, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

/** What the agent is given besides the usual: the task's own variables, with the fixture port in them. */
export function taskEnv(dir: string, task: Task): Record<string, string> {
  const port = existsSync(join(dir, ".bench-port")) ? readFileSync(join(dir, ".bench-port"), "utf8").trim() : "";
  return Object.fromEntries(Object.entries(task.env ?? {}).map(([k, v]) => [k, v.replaceAll("{port}", port).replaceAll("{dir}", dir)]));
}

/** The prompt of the task, with the fixture port in it where it says `{port}` (a task that is about a site the person names by address). */
export function taskPrompt(dir: string, task: Task): string {
  const port = existsSync(join(dir, ".bench-port")) ? readFileSync(join(dir, ".bench-port"), "utf8").trim() : "";
  return task.prompt.replaceAll("{port}", port);
}

/** A random value for one run, in the environment of the setup, the agent and the check: an answer that holds it was made in this run. */
export const newSecret = (): string => crypto.randomUUID().replaceAll("-", "").slice(0, 16);

/** The programs a task needs that this computer does not have. */
export const missingPrograms = (task: Task, has: (program: string) => boolean = (p) => (p === "bash" ? findBash() !== undefined : p === "browser" ? findChrome() !== undefined : Bun.which(p) !== null)): string[] => task.requires.filter((p) => !has(p));

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

/**
 * The bash that runs a task's commands, or nothing. On Windows it is Git's, found beside `git` or where Git for Windows installs; the
 * `bash` that Windows itself ships (in System32, or the WindowsApps stub) only opens a Linux machine that cannot see the workspace.
 */
export function findBash(platform: NodeJS.Platform = process.platform, which: (c: string) => string | null = (c) => Bun.which(c), env: Record<string, string | undefined> = process.env, exists: (p: string) => boolean = existsSync): string | undefined {
  const found = which("bash");
  if (platform !== "win32") return found ?? undefined;
  if (found && !/[\\/](windows[\\/]system32|windowsapps)[\\/]/i.test(found)) return found;
  const git = which("git");
  const roots = [git && win32.dirname(win32.dirname(git)), env.ProgramFiles && win32.join(env.ProgramFiles, "Git"), env.ProgramW6432 && win32.join(env.ProgramW6432, "Git"), env["ProgramFiles(x86)"] && win32.join(env["ProgramFiles(x86)"], "Git"), env.LOCALAPPDATA && win32.join(env.LOCALAPPDATA, "Programs", "Git")];
  return roots.flatMap((r) => (r ? [win32.join(r, "bin", "bash.exe")] : [])).find((p) => exists(p));
}

/** The command line that runs `command`: bash where there is one, else the system's own shell (cmd on Windows). */
export function commandLine(command: string, bash: string | null = findBash() ?? null, platform: NodeJS.Platform = process.platform): string[] {
  if (bash) return [bash, "-c", command];
  return platform === "win32" ? ["cmd.exe", "/d", "/s", "/c", command] : ["sh", "-c", command];
}

/** A shell command in the workspace; `ok` when it exits with 0. */
export async function shell(dir: string, command: string, env: Record<string, string> = {}, timeoutMs = 120_000): Promise<CheckResult> {
  const started = Date.now();
  const p = Bun.spawn(commandLine(command), { cwd: dir, env: { ...gitEnv(), ...env }, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: timeoutMs });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { ok: (await p.exited) === 0, output: `${out}${err}`.slice(-4000), ms: Date.now() - started };
}

export const check = (dir: string, task: Task, timeoutMs = 120_000, env: Record<string, string> = {}): Promise<CheckResult> => shell(dir, task.check, env, timeoutMs);
