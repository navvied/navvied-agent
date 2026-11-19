#!/usr/bin/env bash
# Runs a command in CI. When it fails, the last lines of its output are also written as an error annotation, which anyone can read
# through the public API; the raw job log needs a login.
#   scripts/ci-run.sh <label> <command...>
set -uo pipefail
label=$1; shift
out=$(mktemp)
"$@" 2>&1 | tee "$out"
code=${PIPESTATUS[0]}
if [ "$code" != 0 ]; then
  msg=$(tail -n 70 "$out" | sed -e 's/\x1b\[[0-9;]*[A-Za-z]//g' -e 's/%/%25/g' -e 's/\r//g' | awk '{printf "%s%%0A", $0}')
  echo "::error title=$label failed (exit $code)::${msg:0:30000}"
fi
rm -f "$out"
exit "$code"
