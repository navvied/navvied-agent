import { expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "./repo-files.ts";

test("a test process starts in a scratch folder, outside the repository it tests, so a program run 'here' cannot write to the checkout", () => {
  const here = realpathSync(process.cwd());
  expect(here.startsWith(realpathSync(tmpdir()))).toBe(true);
  expect(here.startsWith(realpathSync(ROOT))).toBe(false);
  const probe = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], { cwd: here, env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined }, stdout: "pipe", stderr: "pipe" });
  expect(probe.exitCode).not.toBe(0);
  expect(join(here, "x").length).toBeGreaterThan(1);
});
