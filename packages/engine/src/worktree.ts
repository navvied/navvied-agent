import { ChildEnv, execFile } from "./process-start.ts";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { gitEnv } from "./git-env.ts";

const git = (cwd: string, args: string[]): Promise<{ ok: boolean; out: string }> =>
  new Promise((done) => execFile("git", args, { cwd, timeout: 60_000, env: ChildEnv.scrubbed(gitEnv()).with({ GIT_TERMINAL_PROMPT: "0" }) }, (err, out, errOut) => done({ ok: !err, out: (out || errOut || "").trim() })));

export interface Isolated {
  /** The folder the helper works in: the same place in a copy of the project. */
  dir: string;
  /** Called when the helper is done and nothing of it is running. An untouched copy is removed; one with changes is kept and the words say where. */
  finish(): Promise<string>;
}

/**
 * A copy of the project's last commit as a git worktree for a helper that may change files, so its changes cannot collide with the
 * ones the person and the agent are making. Uncommitted work is not in the copy.
 */
export async function isolate(cwd: string): Promise<Isolated | { error: string }> {
  const top = await git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!top.ok) return { error: "this folder is not a git project, so there is nothing to make a copy from. Run the helper without isolation." };
  const base = mkdtempSync(join(tmpdir(), "navvied-helper-"));
  const made = await git(top.out, ["worktree", "add", "--detach", base, "HEAD"]);
  if (!made.ok) { rmSync(base, { recursive: true, force: true }); return { error: `could not make a copy of the project: ${made.out.split("\n").at(-1) ?? ""}` }; }
  // Git names the top folder by its real path (forward slashes on Windows, no symlinks on macOS), the folder the person is in may not: compare what both really are.
  const real = (p: string): string => { try { return realpathSync.native(p); } catch { return p; } };
  const dir = join(base, relative(real(top.out), real(cwd)));
  return {
    dir,
    async finish() {
      const changed = await git(base, ["status", "--porcelain"]);
      if (changed.ok && !changed.out) {
        await git(top.out, ["worktree", "remove", "--force", base]);
        rmSync(base, { recursive: true, force: true });
        return "";
      }
      return `\n[the helper worked in a copy of the project at ${base} and left changes there: see them with git -C ${base} diff HEAD, take what you want, then remove it with git worktree remove --force ${base}]`;
    },
  };
}
