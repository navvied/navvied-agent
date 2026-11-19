#!/usr/bin/env bash
# The real app, on a virtual screen, with a known key: where may the key be, and where must it not?
#   scripts/window-check.sh <navvied program>      (the app must be built with --features test-hooks)
# Needs Xvfb, xdotool, curl, ss, dbus-launch. Linux only: macOS and Windows have no virtual screen to run this on.
set -uo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
APP=${NAVVIED_DESKTOP_APP:-$HERE/target/debug/navvied-desktop}
NAV=$(cd "$(dirname "${1:?usage: window-check.sh <navvied program>}")" && pwd)/$(basename "$1")
[ -x "$APP" ] && [ -x "$NAV" ] || { echo "missing: $APP or $NAV" >&2; exit 2; }
CANARY="canary-$(head -c 18 /dev/urandom | base64 | tr '+/=' 'ABC')"
WORK=$(mktemp -d); HOMEDIR=$WORK/home; mkdir -p "$HOMEDIR/.config/navvied"
# The program offers free hosted models by default; this check is about the app, so it must not reach for the network.
echo '{"guestModels":false,"models":{}}' > "$HOMEDIR/.config/navvied/config.json"
fails=0; pids=()
ok()   { echo "ok    $1"; }
fail() { echo "FAIL  $1"; fails=$((fails + 1)); }
check(){ local name=$1; shift; if "$@"; then ok "$name"; else fail "$name"; fi; }
cleanup() { for p in "${pids[@]}"; do kill "$p" 2>/dev/null; done; [ -n "${SIDECAR:-}" ] && kill -9 "$SIDECAR" 2>/dev/null; rm -rf "$WORK"; }
trap cleanup EXIT

d=90; while [ -e /tmp/.X$d-lock ]; do d=$((d + 1)); done
Xvfb :$d -screen 0 1280x800x24 >"$WORK/xvfb.log" 2>&1 & pids+=($!)
export DISPLAY=:$d; sleep 2
eval "$(dbus-launch --sh-syntax)"; pids+=("$DBUS_SESSION_BUS_PID")

export HOME=$HOMEDIR XDG_CONFIG_HOME=$HOMEDIR/.config XDG_DATA_HOME=$HOMEDIR/.local/share XDG_STATE_HOME=$HOMEDIR/.local/state XDG_CACHE_HOME=$HOMEDIR/.cache
export NAVVIED_BIN=$NAV NAVVIED_DESKTOP_TEST_KEY=$CANARY WEBKIT_DISABLE_DMABUF_RENDERER=1 WEBKIT_DISABLE_COMPOSITING_MODE=1 GDK_BACKEND=x11
"$APP" >"$WORK/app.out" 2>&1 & APP_PID=$!; pids+=("$APP_PID")
ID=$(sed -n 's/.*"identifier": *"\([^"]*\)".*/\1/p' "$HERE/src-tauri/tauri.conf.json")
LOG=$HOMEDIR/.local/share/$ID/logs/navvied.log

waitfor() { for _ in $(seq 1 120); do eval "$1" && return 0; sleep 0.25; done; return 1; }
sidecar_pid() { pgrep -P "$APP_PID" -f "$(basename "$NAV")" | head -1; }
port_of() { tr '\0' ' ' < /proc/"$1"/cmdline | sed -n 's/.*--port \([0-9]*\).*/\1/p'; }
environ_of() { tr '\0' '\n' < /proc/"$1"/environ; }

check "the app starts the program" waitfor 'SIDECAR=$(sidecar_pid); [ -n "$SIDECAR" ] && grep -q navvied-ready "$LOG" 2>/dev/null'
[ -n "${SIDECAR:-}" ] || { echo "the program never started; app output:"; tail -5 "$WORK/app.out"; exit 1; }
PORT=$(grep -o '"port":[0-9]*' "$LOG" | head -1 | cut -d: -f2)
sleep 4

runs_with_the_key() { tr '\0' '\n' < /proc/"$1"/environ | grep -qx "NAVVIED_SERVE_TOKEN=$CANARY"; }
check "the key the program runs with is the one the test gave (so the checks below mean something)" runs_with_the_key "$SIDECAR"
check "the program's own updater is off" bash -c "tr '\0' '\n' < /proc/$SIDECAR/environ | grep -qx 'NAVVIED_NO_UPDATE=1'"
# The key reaches curl on standard input, so it is on no command line, not even for a moment.
code() { local key=$1; shift; { [ -n "$key" ] && printf 'header = "Authorization: Bearer %s"\n' "$key"; true; } | curl -s -K - -o /dev/null -w '%{http_code}' "$@"; }
check "no key: refused"                [ "$(code "" "http://127.0.0.1:$PORT/api/info")" = 401 ]
check "a wrong key: refused"           [ "$(code not-the-right-key-at-all "http://127.0.0.1:$PORT/api/info")" = 401 ]
check "the right key: accepted"        [ "$(code "$CANARY" "http://127.0.0.1:$PORT/api/info")" = 200 ]
check "a foreign Host header: refused" [ "$(code "$CANARY" -H 'Host: evil.example' "http://127.0.0.1:$PORT/api/info")" = 403 ]
listens_on_loopback_only() {
  local mine; mine=$(ss -ltnH | awk -v p=":$PORT" '$4 ~ p "$" { print $4 }')
  [ -n "$mine" ] && ! printf '%s\n' "$mine" | grep -qv '^127\.0\.0\.1:'
}
check "the program listens on the loopback address only" listens_on_loopback_only
check "the page is connected with the key (a socket is open to the program)" bash -c "[ \$(ss -tn state established '( sport = :$PORT )' | tail -n +2 | wc -l) -ge 1 ]"

nowhere() {
  local found=0
  grep -rIl -- "$CANARY" "$HOMEDIR" 2>/dev/null | grep -q . && { echo "      in files under the app's home"; found=1; }
  grep -q -- "$CANARY" "$WORK/app.out" && { echo "      in the app's own output"; found=1; }
  # The key goes to awk through the environment: a pipeline whose own command line held the key would find itself.
  local hits; hits=$(ps -eo pid,ppid,args | K=$CANARY awk 'index($0, ENVIRON["K"]) { gsub(ENVIRON["K"], "<key>"); print substr($0, 1, 170) }')
  [ -n "$hits" ] && { echo "      on a command line:"; printf '%s\n' "$hits" | sed 's/^/        /'; found=1; }
  for w in $(xdotool search --name . 2>/dev/null); do xdotool getwindowname "$w" 2>/dev/null; done | grep -qF -- "$CANARY" && { echo "      in a window title"; found=1; }
  grep -qF -- "$CANARY" /proc/"$APP_PID"/cmdline && { echo "      in the app's command line"; found=1; }
  return $found
}
check "the key is in no log, setting, storage file, output, command line or window title" nowhere

# A search that never finds anything proves nothing: plant the key and make sure the search sees it.
echo "$CANARY" > "$HOMEDIR/planted.txt"
if nowhere >/dev/null; then fail "the search finds a key that is planted"; else ok "the search finds a key that is planted"; fi
rm -f "$HOMEDIR/planted.txt"

OLD=$SIDECAR; kill -9 "$OLD"
check "after a crash the program is started again" waitfor 'S=$(sidecar_pid); [ -n "$S" ] && [ "$S" != "$OLD" ] && SIDECAR=$S'
check "the new program runs with the same key" runs_with_the_key "$SIDECAR"
check "it came back on the same port" [ "$(port_of "$SIDECAR")" = "$PORT" ]
sleep 3
check "the key is still nowhere it must not be after the restart" nowhere

kill -9 "$APP_PID"; wait "$APP_PID" 2>/dev/null
dead() { ! kill -0 "$SIDECAR" 2>/dev/null || [ "$(awk '{print $3}' /proc/$SIDECAR/stat 2>/dev/null)" = Z ]; }
check "when the app is killed, the program goes too" waitfor dead

[ "$fails" = 0 ] && echo "all window checks passed" || echo "$fails window check(s) failed"
exit $((fails > 0))
