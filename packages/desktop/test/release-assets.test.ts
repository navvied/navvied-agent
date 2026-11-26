import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CLI_TARGETS, compareAssets, releaseAssets } from "../scripts/release-assets.ts";

const scripts = resolve(import.meta.dir, "..", "scripts");
const all = releaseAssets("1.2.3");

describe("the files a release must hold", () => {
  test("every command-line build, every installer, what the updater needs and latest.json, 25 in all", () => {
    expect(all).toHaveLength(25);
    expect(new Set(all).size).toBe(25);
    expect(all).toEqual(expect.arrayContaining(["navvied-linux-x64", "navvied-windows-x64.exe", "SHA256SUMS", "install.sh", "install.ps1", "latest.json", "SHA256SUMS-desktop",
      "navvied-desktop-1.2.3-linux-x64.deb", "navvied-desktop-1.2.3-linux-x64.AppImage", "navvied-desktop-1.2.3-windows-x64-setup.exe",
      "navvied-desktop-1.2.3-macos-arm64.dmg", "navvied-desktop-1.2.3-macos-x64.dmg", "navvied-desktop-1.2.3-macos-x64.app.tar.gz.sig"]));
    expect(CLI_TARGETS).toHaveLength(9);
  });
  test("one missing file and one file nobody expects are both named", () => {
    expect(compareAssets(all, "1.2.3")).toEqual({ missing: [], unexpected: [] });
    expect(compareAssets(all.filter((n) => !n.endsWith("macos-x64.dmg")), "1.2.3")).toEqual({ missing: ["navvied-desktop-1.2.3-macos-x64.dmg"], unexpected: [] });
    expect(compareAssets([...all, "stray.txt"], "1.2.3")).toEqual({ missing: [], unexpected: ["stray.txt"] });
  });
  const check = (names: string[]) => Bun.spawnSync(["bun", join(scripts, "release-assets.ts"), "check", "1.2.3"], { stdin: new TextEncoder().encode(names.join("\n") + "\n") });
  test("the check a workflow runs fails on a short set and passes on the whole one", () => {
    expect(check(all).exitCode).toBe(0);
    const short = check(all.slice(1));
    expect(short.exitCode).toBe(1);
    expect(short.stderr.toString()).toContain(`missing: ${all[0]}`);
    expect(check([]).exitCode).toBe(1);
  });
});

describe("latest.json", () => {
  const assemble = (names: string[]) => {
    const dir = mkdtempSync(join(tmpdir(), "manifest-"));
    for (const n of names) writeFileSync(join(dir, n), `signature of ${n}\n`);
    const run = Bun.spawnSync(["bun", join(scripts, "assemble-update-manifest.ts"), "v1.2.3"], { cwd: dir });
    let manifest: { version: string; platforms: Record<string, { url: string; signature: string }> } | undefined;
    try { manifest = JSON.parse(readFileSync(join(dir, "latest.json"), "utf8")); } catch { manifest = undefined; }
    rmSync(dir, { recursive: true, force: true });
    return { code: run.exitCode, err: run.stderr.toString(), manifest };
  };
  const built = all.filter((n) => n.startsWith("navvied-desktop-"));
  test("names all four systems the updater serves", () => {
    const r = assemble(built);
    expect(r.code).toBe(0);
    expect(Object.keys(r.manifest!.platforms).sort()).toEqual(["darwin-aarch64", "darwin-x86_64", "linux-x86_64", "windows-x86_64"]);
    expect(r.manifest!.platforms["darwin-x86_64"]!.url).toBe("https://github.com/navvied/navvied-agent/releases/download/v1.2.3/navvied-desktop-1.2.3-macos-x64.app.tar.gz");
  });
  test("is not written when any system's signature or file is missing, or nothing was signed", () => {
    for (const lost of ["navvied-desktop-1.2.3-macos-x64.app.tar.gz.sig", "navvied-desktop-1.2.3-linux-x64.AppImage"]) {
      const r = assemble(built.filter((n) => n !== lost));
      expect(r.code).not.toBe(0);
      expect(r.manifest).toBeUndefined();
    }
    expect(assemble(built.filter((n) => !n.endsWith(".sig"))).code).not.toBe(0);
  });
});
