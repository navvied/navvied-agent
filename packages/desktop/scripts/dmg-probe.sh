#!/usr/bin/env bash
# Finds out, on a macOS runner, what makes a freshly made disk image "busy" — the failure that stops the macOS x64 installer — and which
# way of making the image does not suffer from it. Makes the same kind of image the installer does (an app of about the real size and the
# link to /Applications) several times, each way, and counts how often each fails. The first failure of every way is explained by
# dmg-diagnose.sh (who refused to let the volume go). Not part of any release; run by hand from the "desktop-probe" workflow.
#   scripts/dmg-probe.sh [images per way, default 12]
# Written for the bash 3.2 that macOS ships: no associative arrays.
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
source "$here/ci-annotate.sh"
rounds=${1:-12}
work=$(mktemp -d "${TMPDIR:-/tmp}/dmg-probe.XXXXXX")
results=$work/results.txt
: >"$results"

{ sw_vers; uname -m; sysctl -n machdep.cpu.brand_string; mdutil -s / 2>&1; } >"$work/machine.txt" 2>&1
annotate notice "disk image probe: this machine" "$work/machine.txt"

# Random bytes, as little compressible as the real program inside the app (about 95 MB) and the rest of the app (about 25 MB).
mkdir -p "$work/parts"
head -c 95000000 /dev/urandom >"$work/parts/program"
head -c 25000000 /dev/urandom >"$work/parts/rest"

# $1: folder to fill; $2: "plain", or "quiet" to also tell the file-events daemon and Spotlight to leave the volume alone
stage() {
  mkdir -p "$1/navvied.app/Contents/MacOS" "$1/navvied.app/Contents/Resources"
  cp "$work/parts/program" "$1/navvied.app/Contents/MacOS/navvied"
  cp "$work/parts/rest" "$1/navvied.app/Contents/Resources/rest"
  printf '<plist/>' >"$1/navvied.app/Contents/Info.plist"
  ln -s /Applications "$1/Applications"
  if [ "$2" = quiet ]; then
    mkdir -p "$1/.fseventsd"
    : >"$1/.fseventsd/no_log"
    : >"$1/.metadata_never_index"
  fi
}

# Detaches whatever image this probe left attached, so one failure cannot make the next one fail.
cleanup() {
  for dev in $(hdiutil info | awk -v w="$work" 'index($0, "image-path") && index($0, w) {f = 1} f && /^\/dev\/disk[0-9]+[ \t]/ {print $1; f = 0}'); do
    hdiutil detach -force "$dev" >/dev/null 2>&1 || true
  done
}

# $1: name of the way; $2: stage kind; the rest: the commands (as one shell string in $3), run with $stage and $image set
attempt() {
  way=$1; kind=$2; command=$3; i=1
  while [ "$i" -le "$rounds" ]; do
    stage="$work/stage-$way-$i"; image="$work/$way-$i.dmg"; log="$work/$way-$i.log"
    stage "$stage" "$kind"
    started=$SECONDS
    if (eval "$command") >"$log" 2>&1; then
      echo "$way ok $((SECONDS - started))" >>"$results"
    else
      echo "$way fail $((SECONDS - started))" >>"$results"
      if [ ! -e "$work/explained-$way" ]; then
        : >"$work/explained-$way"
        tail -n 5 "$log" >"$work/$way-tail.txt"
        annotate warning "disk image probe: the first failure of \"$way\"" "$work/$way-tail.txt"
        bash "$here/dmg-diagnose.sh" "$log"
      fi
    fi
    cleanup
    rm -rf "$stage" "$image" "$work/h-$way-$i.dmg"
    i=$((i + 1))
  done
}

# As the bundler's own script makes it: the folder copied into a new image, which hdiutil attaches and detaches by itself.
attempt create plain 'hdiutil create -srcfolder "$stage" -volname probe -fs HFS+ -fsargs "-c c=64,a=16,e=16" -format UDRW "$image"'
# The same, with the volume told in advance that nothing needs to watch it.
attempt create-quiet quiet 'hdiutil create -srcfolder "$stage" -volname probe -fs HFS+ -fsargs "-c c=64,a=16,e=16" -format UDRW "$image"'
# Built from the folder directly, never attached: there is no volume for anything to hold.
attempt hybrid plain 'hdiutil makehybrid -default-volume-name probe -hfs -o "$image" "$stage" && hdiutil convert -format UDRW -ov -o "$image" "$image"'
# The finished download made that way, then opened the way a person opens it: attached read-only, its contents read, detached.
attempt hybrid-final plain 'hdiutil makehybrid -default-volume-name probe -hfs -o "$work/h-$way-$i.dmg" "$stage" && hdiutil convert -format UDZO -ov -o "$image" "$work/h-$way-$i.dmg" && hdiutil verify "$image" && m=$(mktemp -d "$work/mount.XXXXXX") && hdiutil attach -readonly -nobrowse -noautoopen -mountpoint "$m" "$image" >/dev/null && test -d "$m/navvied.app/Contents/MacOS" && test -L "$m/Applications" && cmp "$m/navvied.app/Contents/MacOS/navvied" "$work/parts/program" && hdiutil detach "$m"'

{
  echo "way             images  failed  slowest (s)"
  for way in create create-quiet hybrid hybrid-final; do
    awk -v w="$way" '$1 == w {n++; if ($2 == "fail") f++; if ($3 > s) s = $3} END {printf "%-15s %6d  %6d  %11d\n", w, n, f, s}' "$results"
  done
} >"$work/summary.txt"
cat "$work/summary.txt"
annotate notice "disk image probe: results (failed = Resource busy or any other error)" "$work/summary.txt"
