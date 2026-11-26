import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as native from "node:path";
import { join, win32 } from "node:path";
import { removeTree } from "../../protocol/test/support/cleanup.ts";
import { gitEnv } from "../src/git-env.ts";
import { outsideFolder } from "./outside.ts";

const repository = realpathSync(join(import.meta.dir, "../../.."));
const within = (parent: string, child: string, paths: Pick<typeof native, "relative" | "isAbsolute" | "sep"> = native): boolean => {
  const way = paths.relative(parent, child);
  return !paths.isAbsolute(way) && way !== ".." && !way.startsWith(`..${paths.sep}`);
};

describe("the folder a test uses as neither the project nor a temporary place", () => {
  test("a folder on another drive is not inside, and one below is", () => {
    expect([within("D:\\a\\repo", "C:\\Users\\someone\\away", win32), within("D:\\a\\repo", "D:\\a\\repo\\x", win32), within("D:\\a\\repo", "D:\\a\\other", win32)]).toEqual([false, true, false]);
  });

  test("is outside the repository and outside the temporary folders, so a run that is killed leaves nothing a commit can take", async () => {
    const away = outsideFolder();
    try {
      writeFileSync(join(away, "left.txt"), "x");
      expect(within(repository, away)).toBe(false);
      expect(within(realpathSync(tmpdir()), away)).toBe(false);
    } finally { await removeTree(away); }
  });

  test("no scratch folder of a test is part of the repository", () => {
    const listed = spawnSync("git", ["ls-files"], { cwd: repository, env: gitEnv(process.env), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (listed.status !== 0) return;
    expect(listed.stdout.split("\n").filter((path) => /(^|\/)\.(navvied-test-)?away-/.test(path))).toEqual([]);
  });
});
