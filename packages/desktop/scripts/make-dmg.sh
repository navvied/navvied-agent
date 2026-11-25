#!/usr/bin/env bash
# Makes the macOS disk image from a finished app without ever attaching an image: the folder (the app and the link to /Applications) is
# written straight into an image file. The bundler's own way is to create an image, attach it, fill it and detach it; the moment a volume
# appears, macOS's storage daemon opens its raw device, and the detach is then refused as "Resource busy" now and then. With no volume
# there is nothing for it to open.
#   scripts/make-dmg.sh <app> <output .dmg> <volume name>
set -euo pipefail
app=${1:?the app}; out=${2:?the disk image to write}; name=${3:?the volume name}
[ -d "$app" ] || { echo "no app at $app" >&2; exit 1; }
work=$(mktemp -d "${TMPDIR:-/tmp}/make-dmg.XXXXXX")
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/stage" "$(dirname "$out")"
ditto "$app" "$work/stage/$(basename "$app")"
ln -s /Applications "$work/stage/Applications"
hdiutil makehybrid -default-volume-name "$name" -hfs -o "$work/raw.dmg" "$work/stage"
rm -f "$out"
hdiutil convert -format UDZO -o "$out" "$work/raw.dmg"
hdiutil verify "$out"
