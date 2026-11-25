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

# $1: folder to fill; $2: "plain", or "quiet" to also tell the file-events daemon and Spotlight to leave the volume alone.
# The app is a real, signed one in miniature: a program of the system as its executable, the random bytes as a sealed resource, a link
# inside the bundle and an extended attribute on a file, the things a copy of an app can lose.
stage() {
  app="$1/navvied.app"
  mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
  cp /bin/ls "$app/Contents/MacOS/navvied"
  cp "$work/parts/program" "$app/Contents/Resources/program"
  cp "$work/parts/rest" "$app/Contents/Resources/rest"
  ln -s rest "$app/Contents/Resources/rest-link"
  xattr -w com.navvied.probe kept "$app/Contents/Resources/rest"
  cat >"$app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>navvied</string>
<key>CFBundleIdentifier</key><string>probe.navvied</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
PLIST
  codesign --force --deep --sign - "$app" >/dev/null 2>&1
  ln -s /Applications "$1/Applications"
  if [ "$2" = quiet ]; then
    mkdir -p "$1/.fseventsd"
    : >"$1/.fseventsd/no_log"
    : >"$1/.metadata_never_index"
  fi
}

# Says which check of a chain failed, so the first failure's annotation names it.
need() { "$@" || { echo "check failed: $*" >&2; return 1; }; }

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
# The way the installer now makes it: scripts/make-dmg.sh, from the app alone, never attaching an image.
attempt script plain 'bash "$here/make-dmg.sh" "$stage/navvied.app" "$image" navvied'
# That finished download opened the way a person opens it: attached read-only, its contents read, detached; and the app inside still
# passes the system's own signature check, keeps its link and its extended attribute.
attempt script-opened plain 'bash "$here/make-dmg.sh" "$stage/navvied.app" "$image" navvied && m=$(mktemp -d "$work/mount.XXXXXX") && hdiutil attach -readonly -nobrowse -noautoopen -mountpoint "$m" "$image" >/dev/null && need test -L "$m/Applications" && need cmp "$m/navvied.app/Contents/Resources/program" "$work/parts/program" && need codesign --verify --deep --strict "$m/navvied.app" && need test "$(readlink "$m/navvied.app/Contents/Resources/rest-link")" = rest && need test "$(xattr -p com.navvied.probe "$m/navvied.app/Contents/Resources/rest")" = kept && hdiutil detach "$m"'

{
  echo "way             images  failed  slowest (s)"
  for way in create create-quiet script script-opened; do
    awk -v w="$way" '$1 == w {n++; if ($2 == "fail") f++; if ($3 > s) s = $3} END {printf "%-15s %6d  %6d  %11d\n", w, n, f, s}' "$results"
  done
} >"$work/summary.txt"
cat "$work/summary.txt"
annotate notice "disk image probe: results (failed = Resource busy or any other error)" "$work/summary.txt"
