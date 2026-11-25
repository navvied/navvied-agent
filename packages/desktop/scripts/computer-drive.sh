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
    python3 "$here/packages/cli/test/fixtures/gtk-target.py" & app=$!; needle=navvied-target ;;
  Darwin) open -a TextEdit; app=; needle=TextEdit ;;
  *)      cmd //c start notepad; app=; needle=notepad ;;
esac
sleep 6
bun "$here/packages/cli/src/computer-use/check.ts" --report "$report" --app "$needle"; code=$?
bun "$here/packages/cli/src/computer-use/drive.ts" --report "$report.drive" --app "$needle"; drove=$?; cat "$report.drive" >>"$report" 2>/dev/null; [ $code = 0 ] && code=$drove
[ -n "$app" ] && kill "$app" 2>/dev/null
exit $code
