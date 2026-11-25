import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnGit } from "../src/checkpoints.ts";
import { GIT_LOCAL_ENV, gitEnv } from "../src/git-env.ts";
import { isolate } from "../src/worktree.ts";

const dirs: string[] = [];
const temp = (): string => { const d = mkdtempSync(join(tmpdir(), "navvied-gitenv-")); dirs.push(d); return d; };
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** Everything a stray `git` could change in a repository: its config, its HEAD and its refs. */
const snapshot = (repo: string): string => [readFileSync(join(repo, ".git", "config"), "utf8"), readFileSync(join(repo, ".git", "HEAD"), "utf8"), execFileSync("git", ["for-each-ref"], { cwd: repo, env: gitEnv() }).toString()].join("\n--\n");

describe("git is not pointed at another repository by what the program inherited", () => {
  test("the names git gives for it are taken out, and nothing else", () => {
    const env = gitEnv({ GIT_DIR: "/x", GIT_WORK_TREE: "/y", GIT_INDEX_FILE: "/z", GIT_COMMON_DIR: "/c", GIT_TERMINAL_PROMPT: "0", PATH: "/bin", HOME: "/h" });
    expect(env).toEqual({ GIT_TERMINAL_PROMPT: "0", PATH: "/bin", HOME: "/h" });
    const fromGit = execFileSync("git", ["rev-parse", "--local-env-vars"], { env: gitEnv() }).toString().split("\n").filter(Boolean);
    expect([...GIT_LOCAL_ENV].sort() as string[]).toEqual(fromGit.sort());
  });

  test("with GIT_DIR set to a decoy (what a git hook does), a repository made in a folder of its own, a checkpoint and a helper's copy leave the decoy untouched", async () => {
    const decoy = temp();
    execFileSync("git", ["init", "-q"], { cwd: decoy, env: gitEnv() });
    const before = snapshot(decoy);
    const was = { dir: process.env.GIT_DIR, tree: process.env.GIT_WORK_TREE };
    process.env.GIT_DIR = join(decoy, ".git");
    process.env.GIT_WORK_TREE = decoy;
    try {
      const work = temp();
      for (const args of [["init", "-q"], ["config", "user.email", "t@t.invalid"], ["config", "user.name", "t"], ["config", "core.bare", "false"]]) expect(spawnGit(work, args).ok).toBe(true);
      writeFileSync(join(work, "a.txt"), "one\n");
      expect(spawnGit(work, ["add", "-A"]).ok).toBe(true);
      expect(spawnGit(work, ["commit", "-qm", "first"]).ok).toBe(true);
      expect(existsSync(join(work, ".git"))).toBe(true);
      const copy = await isolate(work);
      if ("error" in copy) throw new Error(copy.error);
      expect(existsSync(join(copy.dir, "a.txt"))).toBe(true);
      await copy.finish();
    } finally {
      if (was.dir === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = was.dir;
      if (was.tree === undefined) delete process.env.GIT_WORK_TREE; else process.env.GIT_WORK_TREE = was.tree;
    }
    expect(snapshot(decoy)).toBe(before);
  });
});
