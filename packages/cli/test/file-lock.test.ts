import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withFileLock } from "../src/file-lock.ts";
import { HOOK_MS, hook, removeTree } from "../../protocol/test/support/cleanup.ts";

const folder = mkdtempSync(join(tmpdir(), "navvied-file-lock-"));
afterAll(hook("the file lock test removes what it made", async () => { await removeTree(folder); }), HOOK_MS);

const refusing = (times: number, platform: NodeJS.Platform, step = 0) => {
  const seen = { asked: 0, clock: Date.now() };
  const open = ((...given: Parameters<typeof openSync>) => {
    seen.asked += 1;
    if (seen.asked <= times) throw Object.assign(new Error("EPERM: operation not permitted, open"), { code: "EPERM" });
    return openSync(...given);
  }) as typeof openSync;
  return { seen, system: { open, platform, now: () => (seen.clock += step) } };
};

describe("a lock that Windows is still removing", () => {
  test("is waited for like a lock another program holds, then taken", () => {
    const path = join(folder, "pending.json");
    const { seen, system } = refusing(3, "win32");
    expect(withFileLock(path, () => existsSync(`${path}.lock`), system)).toBe(true);
    expect(seen.asked).toBe(4);
    expect(existsSync(`${path}.lock`)).toBe(false);
  });

  test("a refusal that does not pass is given back as it is, and the work is not done without the lock", () => {
    const { seen, system } = refusing(Number.POSITIVE_INFINITY, "win32", 1_000);
    let ran = false;
    expect(() => withFileLock(join(folder, "denied.json"), () => { ran = true; }, system)).toThrow("EPERM");
    expect(ran).toBe(false);
    expect(seen.asked).toBeLessThan(10);
  });

  test("elsewhere the same refusal means what it says, at once", () => {
    const { seen, system } = refusing(1, "linux");
    expect(() => withFileLock(join(folder, "linux.json"), () => undefined, system)).toThrow("EPERM");
    expect(seen.asked).toBe(1);
  });
});
