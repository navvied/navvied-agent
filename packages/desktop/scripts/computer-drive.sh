#!/usr/bin/env bash
# Opens a small program of this system and has the pinned screen driver look at it (see packages/cli/src/computer-use/check.ts). Run by the
# "computer-check" workflow, inside a virtual screen on Linux.
#   scripts/computer-drive.sh <report file>
set -uo pipefail
report=$1
here=$(cd "$(dirname "$0")/../../.." && pwd)
case "$(uname -s)" in
  Linux)  python3 "$here/packages/cli/test/fixtures/gtk-target.py" & app=$!; needle=python ;;
  Darwin) open -a TextEdit; app=; needle=TextEdit ;;
  *)      cmd //c start notepad; app=; needle=notepad ;;
esac
sleep 6
bun "$here/packages/cli/src/computer-use/check.ts" --report "$report" --app "$needle"; code=$?
[ -n "$app" ] && kill "$app" 2>/dev/null
exit $code
