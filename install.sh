#!/bin/sh
# Installs navvied: downloads the program for this machine, verifies its checksum, puts it on your PATH.
#   curl -fsSL <url>/install.sh | sh
#   curl -fsSL <url>/install.sh | sh -s -- --version v0.1.0
#   curl -fsSL <url>/install.sh | sh -s -- --then web      installs, then starts navvied and opens the web page already connected
set -eu

base="${NAVVIED_RELEASE_URL:-https://github.com/navvied/navvied-agent/releases/latest/download}"
dir="${NAVVIED_INSTALL_DIR:-$HOME/.local/bin}"
version=""
then=""

while [ $# -gt 0 ]; do
  case "$1" in
    --version) version="${2:-}"; shift 2 ;;
    --dir) dir="${2:-}"; shift 2 ;;
    --then) then="${2:-}"; shift 2 ;;
    *) echo "navvied install: unknown option $1" >&2; exit 2 ;;
  esac
done
case "$then" in "" | web) ;; *) echo "navvied install: --then must be web" >&2; exit 2 ;; esac
if [ -n "$version" ]; then
  case "$base" in
    */releases/latest/download) base="${base%/latest/download}/download/$version" ;;
    *) base="$base/$version" ;;
  esac
fi

fail() { echo "navvied install: $1" >&2; exit 1; }

os="${NAVVIED_OS:-$(uname -s | tr '[:upper:]' '[:lower:]')}"
case "$os" in darwin|linux) ;; *) fail "unsupported system: $os (this script is for macOS and Linux; on Windows use install.ps1)" ;; esac
arch="${NAVVIED_ARCH:-$(uname -m)}"
case "$arch" in
  arm64|aarch64) arch=arm64 ;;
  x86_64|amd64) arch=x64 ;;
  *) fail "unsupported processor: $arch" ;;
esac
variant=""
if [ "$os" = linux ]; then
  libc="${NAVVIED_LIBC:-}"
  if [ -z "$libc" ]; then
    if ls /lib/ld-musl-* /usr/lib/ld-musl-* >/dev/null 2>&1; then libc=musl; else libc=glibc; fi
  fi
  if [ "$libc" = musl ]; then
    variant="-musl"
  elif [ "$arch" = x64 ]; then
    avx2="${NAVVIED_AVX2:-}"
    if [ -z "$avx2" ]; then if grep -qw avx2 /proc/cpuinfo 2>/dev/null; then avx2=yes; else avx2=no; fi; fi
    if [ "$avx2" = no ]; then variant="-baseline"; fi
  fi
fi
asset="navvied-$os-$arch$variant"

if command -v curl >/dev/null 2>&1; then fetch() { curl -fsSL "$1" -o "$2"; }
elif command -v wget >/dev/null 2>&1; then fetch() { wget -qO "$2" "$1"; }
else fail "curl or wget is required"; fi

if command -v sha256sum >/dev/null 2>&1; then sum() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then sum() { shasum -a 256 "$1" | cut -d' ' -f1; }
else fail "sha256sum or shasum is required to verify the download"; fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT INT TERM

echo "Downloading $asset..."
fetch "$base/$asset" "$tmp/$asset" || fail "could not download $base/$asset"
fetch "$base/SHA256SUMS" "$tmp/SHA256SUMS" || fail "could not download the checksum list"
expected="$(grep " $asset\$" "$tmp/SHA256SUMS" | cut -d' ' -f1 | head -n 1)"
[ -n "$expected" ] || fail "no checksum is listed for $asset"
[ "$(sum "$tmp/$asset")" = "$expected" ] || fail "checksum mismatch for $asset; nothing was installed"

mkdir -p "$dir"
chmod +x "$tmp/$asset"
cp "$tmp/$asset" "$dir/navvied.new"
mv -f "$dir/navvied.new" "$dir/navvied"
[ "$os" = darwin ] && xattr -d com.apple.quarantine "$dir/navvied" 2>/dev/null || true

case ":$PATH:" in
  *":$dir:"*) on_path=yes ;;
  *)
    on_path=no
    case "${SHELL:-}" in
      */zsh) rc="$HOME/.zshrc"; line="export PATH=\"$dir:\$PATH\"" ;;
      */fish) rc="$HOME/.config/fish/config.fish"; line="fish_add_path $dir" ;;
      *) rc="$HOME/.bashrc"; line="export PATH=\"$dir:\$PATH\"" ;;
    esac
    mkdir -p "$(dirname "$rc")"
    if ! grep -qsF "$line" "$rc"; then printf '\n# navvied\n%s\n' "$line" >> "$rc"; fi
    ;;
esac

echo "Installed $("$dir/navvied" --version 2>/dev/null | head -n 1) to $dir/navvied"
if [ "$on_path" = no ]; then echo "Open a new terminal (or run: export PATH=\"$dir:\$PATH\"), then type: navvied"; else echo "Type: navvied"; fi

if [ "$then" = web ]; then
  echo "Starting navvied..."
  if (: </dev/tty) 2>/dev/null; then exec "$dir/navvied" web </dev/tty; else exec "$dir/navvied" web; fi
fi
