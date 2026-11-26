#!/usr/bin/env bash
set -uo pipefail
daemon=storagekitd

seen() {
  local pids p
  pids=$(pgrep -x "$daemon" | tr '\n' ' ')
  [ -z "$pids" ] && { echo "storage daemon: not running"; return; }
  for p in $pids; do echo "storage daemon: pid $p, state $(ps -o stat= -p "$p" | tr -d ' ')"; done
}

fail() { echo "error: $*" >&2; exit 1; }

echo "before:"; seen
sudo launchctl bootout "system/com.apple.$daemon" || fail "the launcher refused to take the service away"
sleep 2
echo "after:"; seen
pgrep -x "$daemon" >/dev/null && fail "the daemon is still running"
exit 0
