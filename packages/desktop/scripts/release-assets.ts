#!/usr/bin/env bun
export const CLI_TARGETS = ["linux-x64", "linux-x64-baseline", "linux-x64-musl", "linux-arm64", "linux-arm64-musl", "darwin-arm64", "darwin-x64", "windows-x64", "windows-x64-baseline"] as const;

const extensionOf = (target: string): string => (target.startsWith("windows-") ? ".exe" : "");

const desktopName = (version: string, rest: string): string => `navvied-desktop-${version}-${rest}`;

export const updateFiles = (version: string): Record<string, string> => ({
  "linux-x86_64": desktopName(version, "linux-x64.AppImage"),
  "windows-x86_64": desktopName(version, "windows-x64-setup.exe"),
  "darwin-aarch64": desktopName(version, "macos-arm64.app.tar.gz"),
  "darwin-x86_64": desktopName(version, "macos-x64.app.tar.gz"),
});

export function releaseAssets(version: string): string[] {
  const updates = Object.values(updateFiles(version));
  return [
    ...CLI_TARGETS.map((t) => `navvied-${t}${extensionOf(t)}`),
    "SHA256SUMS", "install.sh", "install.ps1",
    desktopName(version, "linux-x64.deb"), desktopName(version, "macos-arm64.dmg"), desktopName(version, "macos-x64.dmg"),
    ...updates, ...updates.map((u) => `${u}.sig`),
    "SHA256SUMS-desktop", "latest.json",
  ];
}

export function compareAssets(have: readonly string[], version: string): { missing: string[]; unexpected: string[] } {
  const wanted = releaseAssets(version);
  return { missing: wanted.filter((n) => !have.includes(n)), unexpected: have.filter((n) => !wanted.includes(n)) };
}

if (import.meta.main) {
  const [, , command, version] = process.argv;
  if (command === "targets") {
    for (const t of CLI_TARGETS) console.log(`${t} ${extensionOf(t)}`.trim());
  } else if (command === "check" && version) {
    const have = (await Bun.stdin.text()).split("\n").map((l) => l.trim()).filter(Boolean);
    const { missing, unexpected } = compareAssets(have, version);
    for (const n of missing) console.error(`missing: ${n}`);
    for (const n of unexpected) console.error(`unexpected: ${n}`);
    if (missing.length || unexpected.length) process.exit(1);
    console.log(`all ${have.length} release files are there`);
  } else {
    console.error("usage: release-assets.ts targets | check <version> (file names on standard input)");
    process.exit(2);
  }
}
