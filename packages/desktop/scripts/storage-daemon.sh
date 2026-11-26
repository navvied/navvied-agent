#!/usr/bin/env bash
set -uo pipefail
daemon=storagekitd

seen() {
  local pids p
  pids=$(pgrep -x "$daemon" | tr '\n' ' ')
  [ -z "$pids" ] && { echo "storage daemon: not running"; return; }
  for p in $pids; do echo "storage daemon: pid $p, state $(ps -o stat= -p "$p" | tr -d ' ')"; done
}

halted() {
  local p
  for p in $(pgrep -x "$daemon"); do case "$(ps -o stat= -p "$p")" in T*) ;; *) return 1 ;; esac; done
}

fail() { echo "error: $*" >&2; exit 1; }

case "${1:-}" in
  stop)
    echo "before:"; seen
    pgrep -x "$daemon" >/dev/null || fail "the daemon is not running, so there is nothing to halt and the system may start it when an image appears"
    sudo pkill -STOP -x "$daemon"
    echo "after:"; seen
    halted || fail "the daemon did not halt"
    ;;
  remove)
    echo "before:"; seen
    sudo launchctl bootout "system/com.apple.$daemon" || echo "the launcher refused to take the service away"
    sleep 2
    echo "after:"; seen
    pgrep -x "$daemon" >/dev/null && fail "the daemon is still running"
    exit 0
    ;;
  resume)
    sudo pkill -CONT -x "$daemon" || true
    seen
    ;;
  *)
    echo "error: choose stop, remove or resume, not '${1:-}'" >&2
    exit 2
    ;;
esac
