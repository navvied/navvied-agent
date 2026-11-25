#!/usr/bin/env bash
# Opens a small program of this system and has the pinned screen driver look at it (see packages/cli/src/computer-use/check.ts). Run by the
# "computer-check" workflow, inside a virtual screen on Linux.
#   scripts/computer-drive.sh <report file>
set -uo pipefail
report=$1
here=$(cd "$(dirname "$0")/../../.." && pwd)
case "$(uname -s)" in
  Linux)
    # The accessibility bus, started first and asked for by the toolkit, or a window shows only its frame to the driver.
    export GTK_MODULES=gail:atk-bridge NO_AT_BRIDGE=0 GTK_A11Y=atspi
    /usr/libexec/at-spi-bus-launcher --launch-immediately & sleep 2
    dbus-send --session --print-reply --dest=org.a11y.Bus /org/a11y/bus org.freedesktop.DBus.Properties.Set string:org.a11y.Status string:IsEnabled variant:boolean:true >/dev/null 2>&1
    { echo "accessibility bus: $(dbus-send --session --print-reply --dest=org.a11y.Bus /org/a11y/bus org.a11y.Bus.GetAddress 2>&1 | tail -1)"; pgrep -a 'at-spi|dbus' | head -5; } >"$report.a11y" 2>&1
    python3 "$here/packages/cli/test/fixtures/gtk-target.py" & app=$!; needle=navvied-target ;;
  Darwin) open -a TextEdit; app=; needle=TextEdit ;;
  # The program must not hold the output of this script open, or whatever reads it waits for the program to end.
  *)      cmd //c start "" notepad >/dev/null 2>&1 </dev/null; app=; needle=notepad ;;
esac
sleep 6
bun "$here/packages/cli/src/computer-use/check.ts" --report "$report" --app "$needle"; code=$?
bun "$here/packages/cli/src/computer-use/drive.ts" --report "$report.drive" --app "$needle"; drove=$?; cat "$report.drive" >>"$report" 2>/dev/null; [ $code = 0 ] && code=$drove
[ -n "$app" ] && kill "$app" 2>/dev/null
[ "$(uname -s)" != Linux ] && [ "$(uname -s)" != Darwin ] && taskkill //IM notepad.exe //F >/dev/null 2>&1
[ -f "$report.a11y" ] && cat "$report.a11y" >>"$report"
exit $code
