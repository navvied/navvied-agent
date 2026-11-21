#!/usr/bin/env bash
# When the macOS installer build fails because hdiutil could not eject the disk image it just built
# ("Resource busy" — the eject races whatever macOS itself runs against a freshly mounted volume, usually
# Spotlight's own mdworker/mds_stores, sometimes fseventsd), this shows exactly what was still using it —
# lsof on the mount, and the processes known to do this — as its own annotation, instead of leaving
# the next person to guess from the Tauri or create-dmg issue trackers. A build that failed for some other
# reason is not this script's business: it does nothing.
#   scripts/dmg-diagnose.sh <log file of the failed build>
set -uo pipefail
source "$(dirname "$0")/ci-annotate.sh"
out=$1
grep -qE 'hdiutil:.*Resource busy' "$out" || exit 0
diag=$(mktemp)
{
  echo "--- hdiutil info (every attached disk image) ---"
  hdiutil info
  echo
  echo "--- lsof on every mounted volume ---"
  lsof +D /Volumes
  echo
  echo "--- the usual holders (Spotlight, the file-events daemon) ---"
  ps aux | grep -iE 'mdworker|mds_stores|fseventsd|spotlight' | grep -v grep
} >"$diag" 2>&1
annotate warning "the disk image was still busy — this is what else was using it" "$diag"
rm -f "$diag"
