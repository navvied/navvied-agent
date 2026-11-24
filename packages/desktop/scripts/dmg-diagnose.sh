#!/usr/bin/env bash
# When a macOS disk image step fails with "Resource busy" (hdiutil could not detach an image it had just filled), this says who
# refused, as its own annotation, instead of leaving the next person to guess. A busy detach is a refusal: macOS asks every program
# that registered an interest in the volume (Spotlight, the file-events daemon, ...) before it lets go, and the unified log names
# the one that said no ("dissented"). An ordinary `lsof` cannot see it: the daemons run as root, and by then the volume may already
# be unmounted with only the device still held. A build that failed for some other reason is not this script's business: it does nothing.
#   scripts/dmg-diagnose.sh <log file of the failed step>
set -uo pipefail
source "$(dirname "$0")/ci-annotate.sh"
out=$1
grep -qE 'hdiutil:.*Resource busy' "$out" || exit 0
diag=$(mktemp)
{
  echo "--- hdiutil info (every attached disk image) ---"
  hdiutil info
  echo
  echo "--- diskutil list ---"
  diskutil list
  echo
  echo "--- who has a disk device open, as root ---"
  sudo lsof -nP 2>/dev/null | grep -E '[[:space:]]/dev/r?disk[0-9]+' || echo "(nothing)"
  echo
  echo "--- who has a mounted disk image's files open, as root ---"
  for mount_point in $(mount | awk '/^\/dev\/disk[2-9]/ {print $3}'); do
    echo "$mount_point:"
    sudo lsof -nP -- "$mount_point" 2>/dev/null | head -n 20
  done
  echo
  echo "--- the system log: who refused to let the volume go (last 3 minutes) ---"
  sudo log show --last 3m --style compact --info --debug --predicate 'process == "diskarbitrationd" OR process == "diskimages-helper" OR process == "hdiutil" OR eventMessage CONTAINS[c] "dissent"' 2>&1 | cut -c1-240 | tail -n 70
  echo
  echo "--- the usual holders, with what they are doing ---"
  ps -axo pid,ppid,user,etime,pcpu,command | grep -E 'fsck|newfs|mount_|diskimages|hdiutil|ditto|mds|fseventsd|diskarb' | grep -v grep | cut -c1-200
} >"$diag" 2>&1
annotate warning "the disk image was still busy — this is what was using it, and who refused" "$diag"
rm -f "$diag"
