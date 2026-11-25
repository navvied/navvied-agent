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
# The app is a real, signed one in miniature: a program of the system as its executable, the random bytes as a sealed resource and a link
# inside the bundle, the things a copy of an app can lose.
stage() {
  app="$1/navvied.app"
  mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
  cp /bin/ls "$app/Contents/MacOS/navvied"
  cp "$work/parts/program" "$app/Contents/Resources/program"
  cp "$work/parts/rest" "$app/Contents/Resources/rest"
  ln -s rest "$app/Contents/Resources/rest-link"
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
        tail -n 24 "$log" >"$work/$way-tail.txt"
        annotate warning "disk image probe: the first failure of \"$way\"" "$work/$way-tail.txt"
        bash "$here/dmg-diagnose.sh" "$log"
      fi
    fi
    cleanup
    rm -rf "$stage" "$image" "$work"/udf-$i.* "$work"/iso-$i.*
    i=$((i + 1))
  done
}

# As the bundler's own script makes it: the folder copied into a new image, which hdiutil attaches and detaches by itself.
attempt create plain 'hdiutil create -srcfolder "$stage" -volname probe -fs HFS+ -fsargs "-c c=64,a=16,e=16" -format UDRW "$image"'
# The same, with the volume told in advance that nothing needs to watch it.
attempt create-quiet quiet 'hdiutil create -srcfolder "$stage" -volname probe -fs HFS+ -fsargs "-c c=64,a=16,e=16" -format UDRW "$image"'
# The way the installer now makes it: scripts/make-dmg.sh, from the app alone, never attaching an image.
attempt script plain 'bash "$here/make-dmg.sh" "$stage/navvied.app" "$image" navvied'
# Opens an image the way a person does and checks the app inside against the one it was made from ($1). Every check runs, so one
# annotation shows all that is wrong: the system's own signature check on the source (the control), on the app in the image and on a
# copy of it made the way dragging it into Applications makes one; the link, the executable bit and the content.
opened() {
  src=$1; img=$2; bad=0; m=$(mktemp -d "$work/mount.XXXXXX"); out="$work/copy-$way-$i"
  need codesign --verify --deep --strict "$src" || bad=1
  hdiutil attach -readonly -nobrowse -noautoopen -mountpoint "$m" "$img" >/dev/null || return 1
  need test -L "$m/Applications" || bad=1
  need test -x "$m/navvied.app/Contents/MacOS/navvied" || bad=1
  need cmp "$m/navvied.app/Contents/Resources/program" "$src/Contents/Resources/program" || bad=1
  need codesign --verify --deep --strict "$m/navvied.app" || bad=1
  need test "$(readlink "$m/navvied.app/Contents/Resources/rest-link")" = rest || bad=1
  mkdir -p "$out" && ditto "$m/navvied.app" "$out/navvied.app" && { need codesign --verify --deep --strict "$out/navvied.app" || bad=1; }
  if [ $bad = 1 ]; then
    { echo "--- attributes of the app it was made from"; xattr -lr "$src" | grep -E 'com\.apple' | head -3
      echo "--- attributes of the app in the image (with their bytes)"; xattr -lrx "$m/navvied.app" | grep -E -A3 'com\.apple' | head -14
      echo "--- file system of the volume"; diskutil info "$m" | grep -E 'File System|Type'; } >&2
  fi
  hdiutil detach "$m" >/dev/null || bad=1
  rm -rf "$out"
  return $bad
}

# The old way, then opened: tells whether what is lost is lost by every way of making an image or only by the new one.
attempt create-opened plain 'hdiutil create -srcfolder "$stage" -volname probe -fs HFS+ -fsargs "-c c=64,a=16,e=16" -format UDRW "$image" && opened "$stage/navvied.app" "$image"'
# The way of the installer, opened.
attempt script-opened plain 'bash "$here/make-dmg.sh" "$stage/navvied.app" "$image" navvied && opened "$stage/navvied.app" "$image"'
# Written straight from the folder as a UDF volume, or as an ISO 9660 one: neither has Finder information to give, and no
# volume is attached while making it. The tool decides the extension of what it writes, so the file is found by its name without one.
attempt udf-opened plain 'hdiutil makehybrid -default-volume-name probe -udf -o "$work/udf-$i" "$stage" && raw=$(ls "$work"/udf-$i.* | head -n 1) && hdiutil convert -format UDZO -o "$image" "$raw" && hdiutil verify "$image" && opened "$stage/navvied.app" "$image"'
attempt iso-opened plain 'hdiutil makehybrid -default-volume-name probe -iso -o "$work/iso-$i" "$stage" && raw=$(ls "$work"/iso-$i.* | head -n 1) && hdiutil convert -format UDZO -o "$image" "$raw" && hdiutil verify "$image" && opened "$stage/navvied.app" "$image"'
# The fallback, if nothing above keeps the signature: an image of our own that is attached, filled and detached by this script, to count how often that is refused.
attempt manual plain 'hdiutil create -size 300m -fs HFS+ -volname probe -ov "$image" && m=$(mktemp -d "$work/fill.XXXXXX") && hdiutil attach -nobrowse -noautoopen -mountpoint "$m" "$image" >/dev/null && ditto "$stage" "$m" && sync && hdiutil detach "$m"'

# The holder itself (what held the device in the failed release build was the storage daemon, run by root): the old way again, with it stopped
# (it is only stopped, never killed, and started again after) and then with its service removed. A call that hangs is ended after two minutes.
guarded() { perl -e 'alarm shift; exec @ARGV' 120 "$@"; }
attempt create-daemon-stopped plain 'sudo pkill -STOP -x storagekitd; echo "storage daemon: $(pgrep -x storagekitd | tr "\n" " ")stopped=$(ps -o stat= -p "$(pgrep -x storagekitd | head -n 1)" 2>/dev/null)" >&2; guarded hdiutil create -srcfolder "$stage" -volname probe -fs HFS+ -fsargs "-c c=64,a=16,e=16" -format UDRW "$image"; code=$?; sudo pkill -CONT -x storagekitd; exit $code'
attempt create-daemon-removed plain 'sudo launchctl bootout system/com.apple.storagekitd 2>&1; echo "storage daemon running: $(pgrep -x storagekitd | tr "\n" " ")(csrutil: $(csrutil status 2>&1 | head -n 1))" >&2; guarded hdiutil create -srcfolder "$stage" -volname probe -fs HFS+ -fsargs "-c c=64,a=16,e=16" -format UDRW "$image"'

{
  echo "way             images  failed  slowest (s)"
  for way in create create-quiet script create-opened script-opened udf-opened iso-opened manual create-daemon-stopped create-daemon-removed; do
    awk -v w="$way" '$1 == w {n++; if ($2 == "fail") f++; if ($3 > s) s = $3} END {printf "%-15s %6d  %6d  %11d\n", w, n, f, s}' "$results"
  done
} >"$work/summary.txt"
cat "$work/summary.txt"
annotate notice "disk image probe: results (failed = Resource busy or any other error)" "$work/summary.txt"
