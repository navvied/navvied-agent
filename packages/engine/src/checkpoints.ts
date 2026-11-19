import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { CheckpointInfo, RestoreEntry } from "@navvied/protocol";

export type Git = (cwd: string, args: string[], opts?: { env?: Record<string, string>; input?: string }) => { ok: boolean; out: string };

/** A restore gives back the bytes the checkpoint took, so git converts no line endings (Git for Windows turns that on for every repository). */
const EXACT = ["-c", "core.autocrlf=false", "-c", "core.safecrlf=false"];

export const spawnGit: Git = (cwd, args, opts = {}) => {
  try {
    const p = Bun.spawnSync(["git", ...EXACT, ...args], {
      cwd,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C", ...opts.env },
      stdin: opts.input !== undefined ? new TextEncoder().encode(opts.input) : undefined,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 60_000,
    });
    return { ok: p.exitCode === 0, out: p.stdout ? new TextDecoder().decode(p.stdout) : "" };
  } catch {
    return { ok: false, out: "" };
  }
};

export interface RepoSnapshot { root: string; commit: string }
export interface Checkpoint { id: string; at: number; label: string; repos: RepoSnapshot[] }

export interface CheckpointsOptions {
  /** Where the index of checkpoints is kept (one JSON file per session). */
  dir: string;
  session: string;
  git?: Git;
  now?: () => number;
  /** Checkpoints kept per session; older ones are dropped (default 40). */
  limit?: number;
}

const SAFE = /^[A-Za-z0-9_-]{1,80}$/;

/** Takes away the record of one session's checkpoints (a deleted conversation keeps none). The snapshots themselves are git objects nothing points to any more, which git clears with the rest of its unused ones. */
export function forgetCheckpoints(dir: string, session: string): void {
  if (SAFE.test(session)) rmSync(join(dir, `${session}.json`), { force: true });
}

/**
 * Git snapshots of the repositories an agent works in. A snapshot is a commit of the working tree (untracked files
 * included, ignored files not) built in a throw-away index, so the repository's own index, HEAD and files are never touched.
 */
export class Checkpoints {
  readonly #git: Git;
  readonly #o: CheckpointsOptions;

  constructor(opts: CheckpointsOptions) {
    if (!SAFE.test(opts.session)) throw new Error("invalid session id");
    this.#o = opts;
    this.#git = opts.git ?? spawnGit;
  }

  /** The repository root containing `path`, or null. */
  repoOf(path: string): string | null {
    if (!isAbsolute(path)) return null;
    let dir = resolve(path);
    while (dir !== dirname(dir) && !existsSync(dir)) dir = dirname(dir);
    try { if (!statSync(dir).isDirectory()) dir = dirname(dir); } catch { return null; }
    const r = this.#git(dir, ["rev-parse", "--show-toplevel"]);
    return r.ok && r.out.trim() ? r.out.trim() : null;
  }

  /** Start a checkpoint for the repositories behind `paths`. It is saved once it holds at least one repository. */
  begin(label: string, paths: readonly string[]): Checkpoint {
    const cp: Checkpoint = { id: `${(this.#o.now?.() ?? Date.now()).toString(36)}${Math.random().toString(36).slice(2, 6)}`, at: this.#o.now?.() ?? Date.now(), label: label.replace(/\s+/g, " ").trim().slice(0, 140), repos: [] };
    for (const p of paths) this.add(cp, p);
    return cp;
  }

  /** Add the repository behind `path` to `cp` unless it is already in. Returns whether it was added. */
  add(cp: Checkpoint, path: string): boolean {
    const root = this.repoOf(path);
    if (!root || cp.repos.some((r) => r.root === root)) return false;
    const commit = this.#snapshot(root, cp.id);
    if (!commit) return false;
    cp.repos.push({ root, commit });
    this.#save(cp);
    return true;
  }

  list(): Checkpoint[] { return this.#load(); }

  info(): CheckpointInfo[] { return this.#load().map((c) => ({ id: c.id, at: c.at, label: c.label, repos: c.repos.map((r) => basename(r.root)) })); }

  preview(id: string): RestoreEntry[] | null {
    const cp = this.#load().find((c) => c.id === id);
    return cp ? cp.repos.flatMap((r) => this.#diff(r).map(({ path, change }) => ({ repo: basename(r.root), path, change }))) : null;
  }

  /** Put the code back as it was at `id`. The current state is saved first as a new checkpoint (returned as `undoId`). */
  restore(id: string): { changes: RestoreEntry[]; undoId: string | undefined; errors: string[] } | null {
    const cp = this.#load().find((c) => c.id === id);
    if (!cp) return null;
    const undo = this.begin(`Before restoring "${cp.label.slice(0, 60)}"`, cp.repos.map((r) => r.root));
    const changes: RestoreEntry[] = [], errors: string[] = [];
    for (const repo of cp.repos) {
      const diff = this.#diff(repo);
      const failure = this.#apply(repo, diff);
      if (failure) errors.push(failure);
      else changes.push(...diff.map(({ path, change }) => ({ repo: basename(repo.root), path, change })));
    }
    return { changes, undoId: undo.repos.length ? undo.id : undefined, errors };
  }

  #ref(id: string): string { return `refs/navvied/checkpoints/${this.#o.session}/${id}`; }

  #tree(root: string): string | null {
    const index = join(tmpdir(), `navvied-index-${Math.random().toString(36).slice(2)}`);
    const env = { GIT_INDEX_FILE: index };
    try {
      if (this.#git(root, ["rev-parse", "--verify", "-q", "HEAD"]).ok) this.#git(root, ["read-tree", "HEAD"], { env });
      if (!this.#git(root, ["add", "-A", "--", "."], { env }).ok) return null;
      const t = this.#git(root, ["write-tree"], { env });
      return t.ok ? t.out.trim() : null;
    } finally { rmSync(index, { force: true }); }
  }

  #snapshot(root: string, id: string): string | null {
    const tree = this.#tree(root);
    if (!tree) return null;
    const c = this.#git(root, ["-c", "user.name=navvied", "-c", "user.email=checkpoint@navvied.invalid", "commit-tree", tree, "-m", "navvied checkpoint"]);
    const commit = c.ok ? c.out.trim() : "";
    return commit && this.#git(root, ["update-ref", this.#ref(id), commit]).ok ? commit : null;
  }

  /** What restoring would do, comparing the snapshot with the working tree as it is now. */
  #diff(repo: RepoSnapshot): { path: string; change: RestoreEntry["change"] }[] {
    const now = this.#tree(repo.root);
    if (!now) return [];
    const d = this.#git(repo.root, ["diff-tree", "-r", "--name-status", "--no-renames", "-z", repo.commit, now]);
    if (!d.ok) return [];
    const parts = d.out.split("\0").filter(Boolean);
    const out: { path: string; change: RestoreEntry["change"] }[] = [];
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const status = parts[i]![0], path = parts[i + 1]!;
      out.push({ path, change: status === "A" ? "remove" : status === "D" ? "recreate" : "revert" });
    }
    return out;
  }

  #apply(repo: RepoSnapshot, diff: { path: string; change: RestoreEntry["change"] }[]): string | undefined {
    const restore: string[] = [];
    for (const { path, change } of diff) {
      if (change === "remove") {
        const root = resolve(repo.root), target = resolve(root, path);
        if (target.startsWith(root + sep)) rmSync(target, { force: true });
      } else restore.push(path);
    }
    if (!restore.length) return undefined;
    const r = this.#git(repo.root, ["checkout", repo.commit, "--pathspec-from-file=-", "--pathspec-file-nul"], { input: `${restore.join("\0")}\0` });
    if (!r.ok) return `could not restore files in ${repo.root}`;
    this.#git(repo.root, ["reset", "-q"]); // checkout stages what it restores; leave the index as it was
    return undefined;
  }

  #file(): string { return join(this.#o.dir, `${this.#o.session}.json`); }

  #load(): Checkpoint[] {
    try {
      const data = JSON.parse(readFileSync(this.#file(), "utf8")) as Checkpoint[];
      return Array.isArray(data) ? data : [];
    } catch { return []; }
  }

  #save(cp: Checkpoint): void {
    const all = this.#load().filter((c) => c.id !== cp.id);
    all.push(cp);
    const limit = this.#o.limit ?? 40;
    for (const old of all.splice(0, Math.max(0, all.length - limit))) for (const r of old.repos) this.#git(r.root, ["update-ref", "-d", this.#ref(old.id)]);
    mkdirSync(this.#o.dir, { recursive: true });
    const tmp = `${this.#file()}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(all));
    renameSync(tmp, this.#file());
  }
}
