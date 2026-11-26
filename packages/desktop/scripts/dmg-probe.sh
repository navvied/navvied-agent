#!/usr/bin/env bash
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
source "$here/ci-annotate.sh"
rounds=${1:-12}
samples=30
work=$(mktemp -d "${TMPDIR:-/tmp}/dmg-probe.XXXXXX")
report=$work/report.txt
: >"$report"

{ sw_vers; uname -m; csrutil status; } >"$work/machine.txt" 2>&1
annotate notice "disk image probe: this machine" "$work/machine.txt"

mkdir -p "$work/parts"
head -c 95000000 /dev/urandom >"$work/parts/program"

stage() {
  local app="$1/navvied.app"
  mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
  cp /bin/ls "$app/Contents/MacOS/navvied"
  cp "$work/parts/program" "$app/Contents/Resources/program"
  ln -s program "$app/Contents/Resources/program-link"
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
}

bundler_image() { hdiutil create -srcfolder "$1" -volname probe -fs HFS+ -fsargs "-c c=64,a=16,e=16" -format UDRW "$2"; }

detach_all() {
  local dev
  for dev in $(hdiutil info | awk -v w="$work" 'index($0, "image-path") && index($0, w) {f = 1} f && /^\/dev\/disk[0-9]+[ \t]/ {print $1; f = 0}'); do
    hdiutil detach -force "$dev" >/dev/null 2>&1 || true
  done
}

watch_device() {
  local img="$work/watch.dmg" dev n i
  : >"$work/held.txt"
  for i in 1 2 3 4 5 6; do
    hdiutil create -size 50m -fs HFS+ -volname w -ov "$img" >/dev/null 2>&1 || { echo "image $i could not be made" >>"$work/held.txt"; continue; }
    dev=$(hdiutil attach -nobrowse -noautoopen "$img" | awk '/^\/dev\/disk/ {print $1; exit}')
    for n in $(seq 1 "$samples"); do sudo lsof -nP "$dev" "${dev/disk/rdisk}" 2>/dev/null | awk 'NR > 1 {print $1}' | sort -u; sleep 0.1; done |
      sort | uniq -c | awk -v i="$i" -v s="$samples" '{print "attach " i ": " $2 " held it in " $1 " of " s " samples"}' >>"$work/held.txt"
    hdiutil detach "$dev" >/dev/null 2>&1 || detach_all
    rm -f "$img"
  done
  [ -s "$work/held.txt" ] || echo "no program held any of the 6 attached devices in any sample" >>"$work/held.txt"
  cat "$work/held.txt"
}

count_failures() {
  local i failed=0 dir image
  for i in $(seq 1 "$rounds"); do
    dir="$work/stage-$i"; image="$work/made-$i.dmg"
    stage "$dir"
    bundler_image "$dir" "$image" >"$work/make.log" 2>&1 || { failed=$((failed + 1)); tail -n 3 "$work/make.log"; }
    detach_all
    rm -rf "$dir" "$image"
  done
  echo "the bundler's way: $failed of $rounds images failed"
}

signature_survives() {
  local dir="$work/stage-sign" image="$work/sign.dmg" mount verdict="not opened"
  stage "$dir"
  mount=$(mktemp -d "$work/mount.XXXXXX")
  if bundler_image "$dir" "$image" >/dev/null 2>&1 && hdiutil attach -readonly -nobrowse -noautoopen -mountpoint "$mount" "$image" >/dev/null; then
    if codesign --verify --deep --strict "$mount/navvied.app" 2>"$work/sign.log"; then verdict="passes codesign --verify --deep --strict"; else verdict="FAILS codesign: $(tail -n 1 "$work/sign.log")"; fi
    hdiutil detach "$mount" >/dev/null 2>&1 || detach_all
  fi
  detach_all
  rm -rf "$dir" "$image"
  echo "the app in such an image: $verdict"
}

phase() {
  {
    echo "== storage daemon $1"
    watch_device
    count_failures
    signature_survives
  } 2>&1 | tee -a "$report"
}

phase "as it is"

for mode in stop remove; do
  if bash "$here/storage-daemon.sh" "$mode" >"$work/$mode.txt" 2>&1; then
    cat "$work/$mode.txt" >>"$report"
    phase "$mode"
  else
    { echo "== storage daemon $mode: refused"; cat "$work/$mode.txt"; } | tee -a "$report"
  fi
  [ "$mode" = stop ] && bash "$here/storage-daemon.sh" resume >>"$report" 2>&1
done

annotate notice "disk image probe: who held the device, failures and signature, per state of the daemon" "$report"
