import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { VERSION } from "../../cli/src/help.ts";

const ROOT = resolve(import.meta.dir, "../../..");
const manifest = (path: string) => JSON.parse(readFileSync(path, "utf8")) as { name: string; version: string; dependencies?: Record<string, string> };

test("the root and every package share one version, and it is the one the program reports", () => {
  const root = manifest(join(ROOT, "package.json"));
  const packages = readdirSync(join(ROOT, "packages")).map((d) => manifest(join(ROOT, "packages", d, "package.json")));
  expect(root.version).toMatch(/^\d+\.\d+\.\d+$/);
  for (const p of packages) expect(p.version).toBe(root.version);
  expect(VERSION).toBe(root.version);
});

test("packages depend only on each other, through the workspace", () => {
  for (const dir of readdirSync(join(ROOT, "packages"))) {
    const deps = manifest(join(ROOT, "packages", dir, "package.json")).dependencies ?? {};
    for (const [name, range] of Object.entries(deps)) {
      expect(name.startsWith("@navvied/")).toBe(true);
      expect(range).toBe("workspace:*");
    }
  }
});

test("the release workflow builds every build the installers can ask for", () => {
  const workflow = readFileSync(join(ROOT, ".github/workflows/release.yml"), "utf8");
  for (const target of ["linux-x64", "linux-x64-baseline", "linux-x64-musl", "linux-arm64", "linux-arm64-musl", "darwin-arm64", "darwin-x64", "windows-x64", "windows-x64-baseline"]) expect(workflow).toContain(target);
  expect(workflow).toContain("install.sh");
  expect(workflow).toContain("install.ps1");
  expect(workflow).toContain("SHA256SUMS");
});
