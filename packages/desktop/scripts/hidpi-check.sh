#!/usr/bin/env bash
# The real app, on a virtual screen scaled 2x (GDK_SCALE=2 — GNOME's own 200%, the common HiDPI case on Linux),
# with a model already connected: does the window ever leave "Starting navvied…" for the real page?
#   scripts/hidpi-check.sh <navvied program>      (the app must be built with --features test-hooks)
# Needs Xvfb, bun, curl, ss, dbus-launch. Linux only: macOS and Windows have no virtual screen to run this on.
# A model being connected at start-up is the one condition that reproduces this: `running()` (shell.rs) is
# reached and returns, every thread in every one of the app's own processes stays idle, yet the page never
# leaves `starting.html` — confirmed with gdb, not guessed. Caught here without a debugger: a socket only
# connects to the sidecar's own /ws once the real page has loaded and the composer's own JS has run, so a
# model stuck on `starting.html` never has one.
set -uo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
APP=${NAVVIED_DESKTOP_APP:-$HERE/target/debug/navvied-desktop}
NAV=$(cd "$(dirname "${1:?usage: hidpi-check.sh <navvied program>}")" && pwd)/$(basename "$1")
[ -x "$APP" ] && [ -x "$NAV" ] || { echo "missing: $APP or $NAV" >&2; exit 2; }
WORK=$(mktemp -d); HOMEDIR=$WORK/home; mkdir -p "$HOMEDIR/.config/navvied" "$HOMEDIR/.local/share"
fails=0; pids=()
ok()   { echo "ok    $1"; }
fail() { echo "FAIL  $1"; fails=$((fails + 1)); }
check(){ local name=$1; shift; if "$@"; then ok "$name"; else fail "$name"; fi; }
cleanup() { for p in "${pids[@]}"; do kill "$p" 2>/dev/null; done; rm -rf "$WORK"; }
trap cleanup EXIT

cat > "$WORK/mock-model.ts" <<'EOF'
const server = Bun.serve({ port: 0, fetch: () => Response.json({ choices: [{ message: { content: "ok" } }] }) });
process.stdout.write(`${server.port}`);
setInterval(() => {}, 1 << 30);
EOF
bun run "$WORK/mock-model.ts" > "$WORK/mock.port" 2> "$WORK/mock.err" & pids+=($!)
for _ in $(seq 1 40); do [ -s "$WORK/mock.port" ] && break; sleep 0.1; done
MOCK_PORT=$(cat "$WORK/mock.port" 2>/dev/null)
[ -n "$MOCK_PORT" ] || { echo "the mock model never started; see $WORK/mock.err" >&2; cat "$WORK/mock.err" >&2; exit 2; }

d=91; while [ -e /tmp/.X$d-lock ]; do d=$((d + 1)); done
Xvfb :$d -screen 0 2560x1440x24 >"$WORK/xvfb.log" 2>&1 & pids+=($!)
export DISPLAY=:$d; sleep 2
eval "$(dbus-launch --sh-syntax)"; pids+=("$DBUS_SESSION_BUS_PID")

export HOME=$HOMEDIR XDG_CONFIG_HOME=$HOMEDIR/.config XDG_DATA_HOME=$HOMEDIR/.local/share XDG_STATE_HOME=$HOMEDIR/.local/state XDG_CACHE_HOME=$HOMEDIR/.cache
export NAVVIED_BIN=$NAV NAVVIED_DESKTOP_TEST_KEY=hidpi-check-canary-0123456789
export NAVVIED_BASE_URL="http://127.0.0.1:$MOCK_PORT/v1" NAVVIED_MODEL=mock-model
export WEBKIT_DISABLE_DMABUF_RENDERER=1 WEBKIT_DISABLE_COMPOSITING_MODE=1 GDK_BACKEND=x11 GDK_SCALE=2
"$APP" >"$WORK/app.out" 2>&1 & APP_PID=$!; pids+=("$APP_PID")
ID=$(sed -n 's/.*"identifier": *"\([^"]*\)".*/\1/p' "$HERE/src-tauri/tauri.conf.json")
LOG=$HOMEDIR/.local/share/$ID/logs/navvied.log

waitfor() { for _ in $(seq 1 160); do eval "$1" && return 0; sleep 0.25; done; return 1; }
sidecar_pid() { pgrep -P "$APP_PID" -f "$(basename "$NAV")" | head -1; }

check "the app starts the program, with a model connected" waitfor 'SIDECAR=$(sidecar_pid); [ -n "$SIDECAR" ] && grep -q navvied-ready "$LOG" 2>/dev/null'
[ -n "${SIDECAR:-}" ] || { echo "the program never started; app output:"; tail -5 "$WORK/app.out"; exit 1; }
PORT=$(grep -o '"port":[0-9]*' "$LOG" | head -1 | cut -d: -f2)

code() { curl -s -H "Authorization: Bearer hidpi-check-canary-0123456789" -o /dev/null -w '%{http_code}' "$@"; }
check "the sidecar answers /api/info with the token" [ "$(code "http://127.0.0.1:$PORT/api/info")" = 200 ]

# The real signal that the window left starting.html: the composer's own JS has run and opened its socket.
check "the page leaves \"Starting navvied…\" for the real one (a socket is open to the program)" \
  waitfor "[ \$(ss -tn state established '( sport = :$PORT )' | tail -n +2 | wc -l) -ge 1 ]"

[ "$fails" = 0 ] && echo "all HiDPI checks passed" || echo "$fails HiDPI check(s) failed"
exit $((fails > 0))
