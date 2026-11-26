import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const script = resolve(import.meta.dir, "..", "scripts", "storage-daemon.sh");
const stubs: Record<string, string> = {
  pgrep: '[ -f "$STUB/gone" ] && exit 1; echo 182',
  ps: '[ -f "$STUB/halted" ] && echo "T " || echo "Ss "',
  sudo: 'case "$*" in *-STOP*) [ -f "$STUB/refuse" ] || touch "$STUB/halted" ;; *-CONT*) rm -f "$STUB/halted" ;; *bootout*) [ -f "$STUB/refuse" ] && exit 150; touch "$STUB/gone" ;; esac',
  sleep: "exit 0",
};

function run(mode: string, ...flags: ("refuse" | "gone")[]) {
  const dir = mkdtempSync(join(tmpdir(), "storage-daemon-"));
  for (const [name, body] of Object.entries(stubs)) { writeFileSync(join(dir, name), `#!/bin/bash\n${body}\n`); chmodSync(join(dir, name), 0o755); }
  for (const f of flags) writeFileSync(join(dir, f), "");
  const r = Bun.spawnSync(["bash", script, mode], { env: { PATH: `${dir}:${process.env.PATH}`, STUB: dir } });
  rmSync(dir, { recursive: true, force: true });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

describe.skipIf(process.platform === "win32")("taking the storage daemon off the build machine", () => {
  test("stop halts it and shows its state before and after", () => {
    const r = run("stop");
    expect(r.code).toBe(0);
    expect(r.out).toContain("before:\nstorage daemon: pid 182, state Ss");
    expect(r.out).toContain("after:\nstorage daemon: pid 182, state T");
  });
  test("stop fails when it does not halt, and when it is not running", () => {
    expect(run("stop", "refuse")).toMatchObject({ code: 1, err: expect.stringContaining("did not halt") });
    expect(run("stop", "gone")).toMatchObject({ code: 1, err: expect.stringContaining("nothing to halt") });
  });
  test("remove succeeds only when no daemon is left", () => {
    expect(run("remove")).toMatchObject({ code: 0, out: expect.stringContaining("after:\nstorage daemon: not running") });
    expect(run("remove", "refuse")).toMatchObject({ code: 1, out: expect.stringContaining("refused"), err: expect.stringContaining("still running") });
  });
  test("resume lets it go on, and any other word is refused", () => {
    expect(run("resume").code).toBe(0);
    expect(run("unset")).toMatchObject({ code: 2, err: expect.stringContaining("not 'unset'") });
  });
});
