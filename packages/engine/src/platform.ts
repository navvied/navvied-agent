import type { ChildProcess } from "node:child_process";
import { spawnSync } from "node:child_process";

export type Which = (command: string) => string | null;
const defaultWhich: Which = (command) => Bun.which(command, { PATH: process.env.PATH ?? "" });

export interface Shell { name: "bash" | "sh" | "PowerShell" | "cmd"; argv: (command: string) => string[] }

/**
 * The shell that runs the agent's commands. Unix: bash, else sh. Windows: Git Bash if installed (the closest to what
 * models expect), else PowerShell, else cmd.
 */
export function shellFor(platform: NodeJS.Platform = process.platform, which: Which = defaultWhich): Shell {
  if (platform !== "win32") return which("bash") ? { name: "bash", argv: (c) => ["bash", "-c", c] } : { name: "sh", argv: (c) => ["sh", "-c", c] };
  if (which("bash")) return { name: "bash", argv: (c) => ["bash", "-c", c] };
  const ps = which("pwsh") ?? which("powershell");
  if (ps) return { name: "PowerShell", argv: (c) => [ps, "-NoProfile", "-NonInteractive", "-Command", c] };
  return { name: "cmd", argv: (c) => ["cmd.exe", "/d", "/s", "/c", c] };
}

/** Whether child processes get their own process group (so the whole tree can be stopped). */
export const usesProcessGroups = (platform: NodeJS.Platform = process.platform): boolean => platform !== "win32";

/** Stop a process and everything it started. */
export function killTree(child: ChildProcess, platform: NodeJS.Platform = process.platform): void {
  const pid = child.pid;
  try {
    if (platform === "win32") { if (pid) spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" }); else child.kill(); }
    else if (pid) process.kill(-pid, "SIGKILL");
  } catch {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }
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
