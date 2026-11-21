#!/usr/bin/env bash
# The annotation GitHub Actions (and anyone reading the run through the public API, with no login) shows
# for a step: a file's text, escaped for the ::error::/::warning:: commands and capped at GitHub's own
# limit. Shared by every CI helper script, so all of them report a failure or a finding the same way.
#   annotate <level: error|warning> <title> <file> [tail lines, default: the whole file]
annotate() {
  local level=$1 title=$2 file=$3 lines=${4:-0} text msg
  text=$([ "$lines" -gt 0 ] && tail -n "$lines" "$file" || cat "$file")
  msg=$(echo "$text" | sed -e 's/\x1b\[[0-9;]*[A-Za-z]//g' -e 's/%/%25/g' -e 's/\r//g' | awk '{printf "%s%%0A", $0}')
  echo "::$level title=$title::${msg:0:30000}"
}

annotate_failure() {
  annotate error "$1 failed (exit $2)" "$3" 70
}
