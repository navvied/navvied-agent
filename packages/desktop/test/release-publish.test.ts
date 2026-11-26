import { describe, expect, test } from "bun:test";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { releaseAssets } from "../scripts/release-assets.ts";

const ROOT = resolve(import.meta.dir, "../../..");
type Step = { name?: string; run?: string; "working-directory"?: string };
const workflow = Bun.YAML.parse(readFileSync(join(ROOT, ".github/workflows/release.yml"), "utf8")) as { jobs: { publish: { steps: Step[] } } };
const steps = workflow.jobs.publish.steps.filter((s) => s.run);
const built = releaseAssets("1.2.3").filter((n) => n !== "SHA256SUMS-desktop" && n !== "latest.json");

const gh = `#!/usr/bin/env bash
echo "$*" >> "$STUB/calls"
case "$*" in
  "release view v1.2.3 --json isDraft"*) [ "$STATE" = none ] && exit 1; echo "$STATE" ;;
  "release view v1.2.3 --json assets"*) cat "$STUB/attached" ;;
  "release create "*|"release upload "*) for a in "$@"; do [ -f "$a" ] && basename "$a"; done | grep -v "^$DROPPED$" > "$STUB/attached"; true ;;
esac
`;

function publish(files: string[], state: "none" | "true" | "false", dropped = "-") {
  const dir = mkdtempSync(join(tmpdir(), "publish-"));
  mkdirSync(join(dir, "release"));
  cpSync(join(ROOT, "packages/desktop/scripts"), join(dir, "packages/desktop/scripts"), { recursive: true });
  for (const f of files) writeFileSync(join(dir, "release", f), `content of ${f}\n`);
  writeFileSync(join(dir, "gh"), gh);
  chmodSync(join(dir, "gh"), 0o755);
  writeFileSync(join(dir, "calls"), "");
  let failed: string | undefined;
  for (const s of steps) {
    const r = Bun.spawnSync(["bash", "-e", "-c", s.run!], {
      cwd: join(dir, s["working-directory"] ?? "."),
      env: { PATH: `${dir}:${process.env.PATH}`, STUB: dir, STATE: state, DROPPED: dropped, GITHUB_REF_NAME: "v1.2.3" },
    });
    if (r.exitCode !== 0) { failed = s.name; break; }
  }
  const calls = readFileSync(join(dir, "calls"), "utf8").split("\n").filter(Boolean).map((c) => c.split(" ").slice(0, 2).join(" ") + (c.includes("--draft=false") ? " --draft=false" : c.includes("--json assets") ? " assets" : c.includes("--json isDraft") ? " state" : ""));
  rmSync(dir, { recursive: true, force: true });
  return { failed, calls };
}

describe.skipIf(process.platform === "win32")("the last job of a release, run with a stand-in for the release service", () => {
  test("with every file there: a draft is made, its files are checked, and only then is it published", () => {
    expect(publish(built, "none")).toEqual({ failed: undefined, calls: ["release view state", "release create", "release view assets", "release edit --draft=false"] });
  });
  test("with an installer or a signature missing nothing at all is written", () => {
    for (const lost of ["navvied-desktop-1.2.3-macos-x64.dmg", "navvied-desktop-1.2.3-windows-x64-setup.exe.sig", "navvied-linux-arm64"]) {
      const r = publish(built.filter((n) => n !== lost), "none");
      expect(r.failed).toBeDefined();
      expect(r.calls).toEqual([]);
    }
  });
  test("a draft left by an earlier run is filled again and then published", () => {
    expect(publish(built, "true").calls).toEqual(["release view state", "release upload", "release view assets", "release edit --draft=false"]);
  });
  test("a published release is never changed", () => {
    const r = publish(built, "false");
    expect(r.failed).toBe("A draft that holds the files");
    expect(r.calls).toEqual(["release view state"]);
  });
  test("a file that did not reach the draft keeps it a draft", () => {
    const r = publish(built, "none", "navvied-desktop-1.2.3-macos-arm64.dmg");
    expect(r.failed).toBe("Every file is attached to the draft");
    expect(r.calls).not.toContain("release edit --draft=false");
  });
});
