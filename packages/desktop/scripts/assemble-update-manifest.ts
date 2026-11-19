#!/usr/bin/env bun
// Builds the `latest.json` the desktop app's updater polls (`tauri.conf.json`'s `plugins.updater.endpoint`),
// from the `.sig` files `cargo tauri build --features updater` wrote next to the signed release assets.
// Run from the directory holding those assets (the release's own `out/`), with the release tag as argv[2]
// (e.g. "v0.2.0"). Writes nothing and exits 0, quietly, when no `.sig` exists: that means this release was
// built unsigned (no TAURI_SIGNING_PRIVATE_KEY secret yet), which is not a failure, just nothing to offer.
//
// .deb is deliberately never a platform here even once signed: it is a system package, replaced by the
// system's own package manager, not something this app's in-process updater can apply to itself.
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";

const [, , tag] = process.argv;
if (!tag?.startsWith("v")) throw new Error("usage: assemble-update-manifest.ts <tag, e.g. v0.2.0>  (run inside the release's out/ directory)");
const version = tag.slice(1);
const base = `https://github.com/navvied/navvied-agent/releases/download/${tag}`;

if (readdirSync(".").every((f) => !f.endsWith(".sig"))) {
  console.log("no .sig files here: this release was built unsigned, no latest.json");
  process.exit(0);
}

function platform(asset: string): { signature: string; url: string } | undefined {
  if (!existsSync(`${asset}.sig`)) return undefined;
  return { signature: readFileSync(`${asset}.sig`, "utf8").trim(), url: `${base}/${asset}` };
}

const platforms: Record<string, { signature: string; url: string }> = {};
const wanted: Record<string, string> = {
  "linux-x86_64": `navvied-desktop-${version}-linux-x64.AppImage`,
  "windows-x86_64": `navvied-desktop-${version}-windows-x64-setup.exe`,
  "darwin-aarch64": `navvied-desktop-${version}-macos-arm64.app.tar.gz`,
  "darwin-x86_64": `navvied-desktop-${version}-macos-x64.app.tar.gz`,
};
for (const [key, asset] of Object.entries(wanted)) {
  const found = platform(asset);
  if (found) platforms[key] = found;
}
if (Object.keys(platforms).length === 0) throw new Error("signed, but none of the expected assets' .sig files were found — the asset names above are stale");

writeFileSync("latest.json", `${JSON.stringify({ version, notes: "See the release notes.", pub_date: new Date().toISOString(), platforms }, null, 2)}\n`);
console.log(readFileSync("latest.json", "utf8"));
