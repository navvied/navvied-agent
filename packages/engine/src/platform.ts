import type { ChildProcess } from "node:child_process";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { win32 } from "node:path";

export type Which = (command: string) => string | null;
const defaultWhich: Which = (command) => Bun.which(command, { PATH: process.env.PATH ?? "" });

export interface Shell { name: "bash" | "sh" | "PowerShell" | "cmd"; argv: (command: string) => string[] }

/** The `bash` Windows ships is only a door into WSL: it runs commands in a Linux machine that cannot see the project's drive paths. */
const isWslDoor = (path: string): boolean => /[\\/](windows[\\/]system32|windowsapps)[\\/]/i.test(path);

/**
 * A command as PowerShell must be given it. One that starts with a quoted program path (`"C:\\tools\\a.exe" arg`) is only a string
 * there, so it is called with `&`. And a program's own exit code is passed on: -Command turns every code but 0 into 1, which would
 * turn a hook's "stop this" (2) into "it failed".
 */
const powershellScript = (command: string): string => `${/^\s*["']/.test(command) ? "& " : ""}${command}\nif ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }`;

/** Git's own bash: next to the `git` on the path, else where Git for Windows installs. */
function gitBash(which: Which, env: NodeJS.ProcessEnv, exists: (path: string) => boolean): string | undefined {
  const git = which("git");
  const roots = [git && win32.dirname(win32.dirname(git)), git && win32.dirname(win32.dirname(win32.dirname(git))), env.ProgramFiles && win32.join(env.ProgramFiles, "Git"), env.ProgramW6432 && win32.join(env.ProgramW6432, "Git"), env["ProgramFiles(x86)"] && win32.join(env["ProgramFiles(x86)"], "Git"), env.LOCALAPPDATA && win32.join(env.LOCALAPPDATA, "Programs", "Git")];
  for (const root of roots) {
    const bash = root ? win32.join(root, "bin", "bash.exe") : undefined;
    if (bash && exists(bash)) return bash;
  }
  return undefined;
}

/**
 * The shell that runs the agent's commands. Unix: bash, else sh. Windows: Git Bash if installed (the closest to what
 * models expect; never the WSL door that is also called bash), else PowerShell, else cmd.
 */
export function shellFor(platform: NodeJS.Platform = process.platform, which: Which = defaultWhich, env: NodeJS.ProcessEnv = process.env, exists: (path: string) => boolean = existsSync): Shell {
  if (platform !== "win32") return which("bash") ? { name: "bash", argv: (c) => ["bash", "-c", c] } : { name: "sh", argv: (c) => ["sh", "-c", c] };
  const found = which("bash");
  const bash = found && !isWslDoor(found) ? found : gitBash(which, env, exists);
  if (bash) return { name: "bash", argv: (c) => [bash, "-c", c] };
  const ps = which("pwsh") ?? which("powershell");
  if (ps) return { name: "PowerShell", argv: (c) => [ps, "-NoProfile", "-NonInteractive", "-Command", powershellScript(c)] };
  return { name: "cmd", argv: (c) => ["cmd.exe", "/d", "/s", "/c", c] };
}

/**
 * What to start for a program and its arguments. Windows starts only real programs: a `.cmd` or `.bat` (npx, and most programs
 * installed with npm) must go through cmd.exe, which reads quotes and `%` itself, so text that cmd would read as something else is
 * refused with a sentence rather than passed on. Elsewhere, and for a real program, the argument list is returned as it is.
 */
export function launch(argv: string[], platform: NodeJS.Platform = process.platform, which: Which = defaultWhich): string[] {
  const [program, ...args] = argv;
  if (platform !== "win32" || !program) return argv;
  const found = which(program);
  if (!found || !/\.(cmd|bat)$/i.test(found)) return found ? [found, ...args] : argv;
  const unsafe = args.find((a) => /["%\r\n]/.test(a));
  if (unsafe !== undefined) throw new Error(`${win32.basename(found)} is a batch file, and Windows would read the quotes, percent signs or line breaks in ${JSON.stringify(unsafe.slice(0, 40))} as its own. Install the program as an .exe, or avoid them.`);
  return ["cmd.exe", "/d", "/s", "/c", `"${[found, ...args].map((a) => `"${a}"`).join(" ")}"`];
}

/** Whether child processes get their own process group (so the whole tree can be stopped). */
export const usesProcessGroups = (platform: NodeJS.Platform = process.platform): boolean => platform !== "win32";

/** Stop a process and everything it started. */
export function killTree(child: Pick<ChildProcess, "pid" | "kill">, platform: NodeJS.Platform = process.platform): void {
  const pid = child.pid;
  try {
    if (platform === "win32") { if (pid) spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" }); else child.kill(); }
    else if (pid) process.kill(-pid, "SIGKILL");
  } catch {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }
}

/**
 * When a process started, as the system writes it down: a process number alone is not the process (numbers are used again), the number
 * with its start time is. Nothing on Windows, where a program is not taken back after a restart.
 */
export function processStart(pid: number, platform: NodeJS.Platform = process.platform): string | undefined {
  try {
    if (platform === "linux") { const stat = readFileSync(`/proc/${pid}/stat`, "utf8"); return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]; }
    if (platform === "darwin") { const r = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" }); return r.status === 0 ? r.stdout.trim() || undefined : undefined; }
  } catch { /* it is not there */ }
  return undefined;
}

const quoted = (word: string): string => `'${word.replace(/'/g, `'\\''`)}'`;

/**
 * The command run inside a terminal (a pty), for programs that only behave when they think a person is typing: a REPL, an installer
 * that asks questions. It is the `script` program every Linux and macOS computer has, so nothing is added to navvied. On Windows, or
 * where `script` is missing, there is none and the command runs with plain pipes.
 */
export function inTerminal(argv: string[], platform: NodeJS.Platform = process.platform, which: Which = defaultWhich): string[] | undefined {
  if (!which("script")) return undefined;
  if (platform === "linux") return ["script", "-qefc", argv.map(quoted).join(" "), "/dev/null"];
  if (platform === "darwin") return ["sh", "-c", MAC_TERMINAL, "sh", ...argv];
  return undefined;
}

/**
 * macOS `script` stops at once ("tcgetattr: Operation not supported on socket") when its input is a socket, and a socket is what
 * Bun and Node give a child as its input; a pipe it accepts. So `cat` copies the input into a pipe. `cat` runs in the background so the
 * command ends when the program does: a pipeline would wait for `cat`, which waits for input nobody sends. It ends when the job's input
 * is closed, which Bun and Node do when the program ends, and it is in the job's process group, so stopping the job stops it too.
 */
const MAC_TERMINAL = '{ cat 0<&3 3<&- 2>/dev/null & } 3<&0 | script -q /dev/null "$@"';
