#!/usr/bin/env bash
# Runs a command in CI. When it fails, the last lines of its output are also written as an error annotation, which anyone can read
# through the public API; the raw job log needs a login. The output is a scratch file, removed once this exits — unless CI_RUN_LOG
# names a path, which is then left in place with the output for a later step to read (a step that itself only runs on failure).
#   CI_RUN_LOG=/path/to/keep scripts/ci-run.sh <label> <command...>
set -uo pipefail
source "$(dirname "$0")/ci-annotate.sh"
label=$1; shift
out=${CI_RUN_LOG:-$(mktemp)}
"$@" 2>&1 | tee "$out"
code=${PIPESTATUS[0]}
[ "$code" != 0 ] && annotate_failure "$label" "$code" "$out"
[ -z "${CI_RUN_LOG:-}" ] && rm -f "$out"
exit "$code"
