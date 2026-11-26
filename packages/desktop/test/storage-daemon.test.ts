import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const script = resolve(import.meta.dir, "..", "scripts", "storage-daemon.sh");
const stubs: Record<string, string> = {
  pgrep: '[ -f "$STUB/gone" ] && exit 1; echo 182',
  ps: 'echo "Ss "',
  sudo: '[ -f "$STUB/refuse" ] && exit 150; [ -f "$STUB/survives" ] || touch "$STUB/gone"',
  sleep: "exit 0",
};

function run(...flags: ("refuse" | "survives" | "gone")[]) {
  const dir = mkdtempSync(join(tmpdir(), "storage-daemon-"));
  for (const [name, body] of Object.entries(stubs)) { writeFileSync(join(dir, name), `#!/bin/bash\n${body}\n`); chmodSync(join(dir, name), 0o755); }
  for (const f of flags) writeFileSync(join(dir, f), "");
  const r = Bun.spawnSync(["bash", script], { env: { PATH: `${dir}:${process.env.PATH}`, STUB: dir } });
  rmSync(dir, { recursive: true, force: true });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

describe.skipIf(process.platform === "win32")("taking the storage daemon off the build machine", () => {
  test("it succeeds when no daemon is left, and shows its state before and after", () => {
    const r = run();
    expect(r.code).toBe(0);
    expect(r.out).toContain("before:\nstorage daemon: pid 182, state Ss");
    expect(r.out).toContain("after:\nstorage daemon: not running");
  });
  test("it fails when the launcher refuses, even if the daemon is not running now, because the launcher could start it again", () => {
    expect(run("refuse")).toMatchObject({ code: 1, err: expect.stringContaining("refused") });
    expect(run("refuse", "gone")).toMatchObject({ code: 1, err: expect.stringContaining("refused") });
  });
  test("it fails when the daemon is still running afterwards", () => {
    expect(run("survives")).toMatchObject({ code: 1, err: expect.stringContaining("still running") });
  });
});
