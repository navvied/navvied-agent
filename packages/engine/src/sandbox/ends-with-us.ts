import { spawn, type ChildProcess } from "../process-start.ts";
import { randomUUID } from "node:crypto";

export const ENDS_WITH_MARK = "NAVVIED_ENDS_WITH";

const END_THEM_WHEN_THE_PIPE_CLOSES = `while read -r _; do :; done
for pass in first again; do
  for file in $(grep -l "${ENDS_WITH_MARK}=$1:" /proc/[0-9]*/environ 2>/dev/null); do
    entry=\${file%/environ}
    group=$(tr '\\0' '\\n' 2>/dev/null < "$file" | sed -n "s/^${ENDS_WITH_MARK}=$1://p")
    [ -n "$group" ] || continue
    read -r status 2>/dev/null < "$entry/stat" || continue
    status=\${status##*) }; status=\${status#* }; status=\${status#* }
    [ "\${status%% *}" = "$group" ] && kill -KILL "\${entry#/proc/}" 2>/dev/null
  done
done`;

const NOWHERE_ANYONE_WORKS = "/";

const MARK_THE_GROUP = `${ENDS_WITH_MARK}="$1:$$"; export ${ENDS_WITH_MARK}; shift; exec "$@"`;

const token = randomUUID();
let watcher: ChildProcess | undefined;

export const startWatcher = (token: string): ChildProcess => spawn("sh", ["-c", END_THEM_WHEN_THE_PIPE_CLOSES, "sh", token], { cwd: NOWHERE_ANYONE_WORKS, stdio: ["pipe", "ignore", "ignore"], detached: true });

function watch(): void {
  if (watcher) return;
  const child = startWatcher(token);
  const gone = (): void => { if (watcher === child) watcher = undefined; };
  child.once("error", gone);
  child.once("exit", gone);
  child.stdin?.on("error", gone);
  child.unref();
  (child.stdin as unknown as { unref?: () => void } | null)?.unref?.();
  watcher = child;
}

export function endsWithThisProgram(argv: readonly string[]): string[] {
  watch();
  return ["sh", "-c", MARK_THE_GROUP, "sh", token, ...argv];
}
