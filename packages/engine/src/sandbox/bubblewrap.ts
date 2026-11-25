import type { Plan, Setting } from "./policy.ts";

/** The arguments of bubblewrap for a plan: everything is read-only except what the plan lets be written, and what it hides cannot be opened. */
export function bubblewrapArgs(plan: Plan, setting: Pick<Setting, "network">, o: { cwd: string; filter: boolean; dieWithParent: boolean; /** Join the user namespace open as descriptor 6 (see `joinUserns`). */ userns?: boolean }): string[] {
  return [
    ...(o.userns ? ["--userns", "6"] : []),
    "--ro-bind", "/", "/",
    "--dev", "/dev",
    ...(o.dieWithParent ? ["--die-with-parent"] : []),
    "--cap-drop", "ALL",
    ...(setting.network ? [] : ["--unshare-net"]),
    ...plan.writable.flatMap((w) => ["--bind", w, w]),
    // A folder that cannot be opened (not an empty one: a program that reads it says why it failed); a file is an empty one, so a program that reads its settings goes on.
    ...plan.hiddenDirs.flatMap((d) => ["--perms", "000", "--tmpfs", d]),
    ...plan.hiddenFiles.flatMap((f) => ["--ro-bind", "/dev/null", f]),
    ...(o.filter ? ["--seccomp", "3"] : []),
    "--chdir", o.cwd,
    "--",
  ];
}

/**
 * The command that starts bubblewrap. The filter is a file that the shell opens as descriptor 3 (bubblewrap reads and closes it before the
 * program starts), so no place that starts a program has to know about it. The shell becomes bubblewrap: the process group is the same.
 */
export const withFilter = (file: string, bwrap: string[], argv: string[]): string[] => ["sh", "-c", 'exec 3<"$1" && shift && exec "$@"', "sh", file, "bwrap", ...bwrap, ...argv];

/**
 * The first program inside the sandbox of a command that must not outlive this program. Bubblewrap arms `--die-with-parent` only once it runs, so a
 * parent that dies earlier (within about 25 ms of the start) would leave the command behind. This guard runs only after bubblewrap armed it (it is
 * bubblewrap's own child), says so on descriptor 4, and starts the command once the engine answers on descriptor 5 (`handshake.ts`). An engine that
 * died before answering closes descriptor 5 and the guard ends; one that dies after takes bubblewrap and the command with it, both armed by then.
 * Bubblewrap's own `--info-fd` is not used for this: a reader that is gone kills bubblewrap with SIGPIPE and leaves its child stuck for ever.
 * Shell built-ins only.
 */
export const GUARD = 'echo >&4; read -r _ <&5 || exit 125; exec 4<&- 5<&-; exec "$@"';
export const guarded = (argv: string[]): string[] => ["sh", "-c", GUARD, "sh", ...argv];

/** Opens the user namespace `file` names as descriptor 6, for `--userns 6`, and then starts `argv` (what `bubblewrapArgs` asked for). */
export const joinUserns = (file: string, argv: string[]): string[] => ["sh", "-c", 'exec 6<"$1" && shift && exec "$@"', "sh", file, ...argv];
