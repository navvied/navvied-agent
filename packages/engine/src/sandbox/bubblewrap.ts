import type { Plan, Setting } from "./policy.ts";

/** The arguments of bubblewrap for a plan: everything is read-only except what the plan lets be written, and what it hides cannot be opened. */
export function bubblewrapArgs(plan: Plan, setting: Pick<Setting, "network">, o: { cwd: string; filter: boolean; dieWithParent: boolean }): string[] {
  return [
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
