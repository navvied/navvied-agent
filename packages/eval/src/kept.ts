import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { secretNames } from "../../engine/src/child-env.ts";
import { gitEnv } from "../../engine/src/git-env.ts";
import { check, scriptEnv, type CheckResult } from "./workspace.ts";

/**
 * What is kept of a run that did not solve its task, so that the miss can be worked out again later: the workspace as the check found it,
 * the check, and the run's BENCH_SECRET (a random value the fixtures are made from, not a credential). Nothing outside the workspace is
 * read, and no key of the run or of the environment is in the copy.
 */

/** Where failed runs are kept: beside the trace or the results that were asked for. With neither, nothing is kept. */
export const keptFolder = (trace?: string, out?: string): string | undefined => (trace ? resolve(trace, "failed") : out ? resolve(`${out}.failed`) : undefined);

export interface Limits { fileBytes: number; totalBytes: number; files: number }
export const LIMITS: Limits = { fileBytes: 2 * 1024 * 1024, totalBytes: 20 * 1024 * 1024, files: 2000 };

/** Folders that are installed or made again from the rest, and can be huge. */
const LEFT_OUT = new Set(["node_modules", ".venv", "__pycache__"]);
/** How a packed file starts (gzip, zip, xz, zstd, bzip2): what is inside cannot be searched for a key. */
const PACKED = ["\x1f\x8b", "PK\x03\x04", "\xfd7zXZ", "\x28\xb5\x2f\xfd", "BZh"];
const MOST_NAMED = 100;

export interface Snapshot {
  files: { path: string; bytes: Buffer; executable: boolean }[];
  /** What is not in the copy and why, at most the first hundred; `more` counts the rest. */
  skipped: string[];
  more: number;
}

/** The values that must never be written down: the keys given, and every variable whose name says it holds a secret. The fixtures' own values (`BENCH_*`) are what a check works from. */
export function secretsOf(given: readonly (string | undefined)[], ...envs: Readonly<Record<string, string | undefined>>[]): string[] {
  const env = Object.assign({}, ...envs) as Record<string, string | undefined>;
  const named = secretNames(env).filter((n) => !n.startsWith("BENCH_")).map((n) => env[n]);
  return [...new Set([...given, ...named].filter((k): k is string => !!k && k.length >= 8 && k !== "none"))].sort((a, b) => b.length - a.length);
}

export const without = (secrets: readonly string[]) => (text: string): string => secrets.reduce((t, k) => t.split(k).join("[key]"), text);

/** The bytes of a text as a string of one character per byte, so that any file can be searched and rewritten without being changed otherwise. */
const asBytes = (text: string): string => Buffer.from(text, "utf8").toString("latin1");

/** A git folder by its layout, whatever its name: a bare copy of the repository is one too. */
const isGit = (dir: string): boolean => existsSync(join(dir, "HEAD")) && existsSync(join(dir, "objects"));

/** Git's objects are packed, so they are read through git, every one of them (also those no commit leads to). Unreadable counts as holding a key. */
function gitHolds(gitDir: string, secrets: readonly string[]): boolean {
  const r = Bun.spawnSync(["git", `--git-dir=${gitDir}`, "cat-file", "--batch-all-objects", "--batch"], { env: gitEnv(), stdout: "pipe", stderr: "ignore", maxBuffer: 256 * 1024 * 1024 });
  if (r.exitCode !== 0) return true;
  const all = r.stdout.toString("latin1");
  return secrets.some((k) => all.includes(asBytes(k)));
}

function sizeOf(dir: string, most: number): number {
  let total = 0;
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      if (total > most) return;
      const s = lstatSync(join(d, name));
      if (s.isDirectory()) walk(join(d, name)); else total += s.size;
    }
  };
  walk(dir);
  return total;
}

/** The workspace read into memory, within the limits and with every secret replaced. Links are not followed: they can lead anywhere, to a key file as well. */
export function snapshot(dir: string, secrets: readonly string[], limits: Limits = LIMITS): Snapshot {
  const out: Snapshot = { files: [], skipped: [], more: 0 };
  const hidden = secrets.map(asBytes), clean = without(hidden);
  const holds = (text: string): boolean => hidden.some((k) => text.includes(k));
  let total = 0;
  const skip = (path: string, why: string): void => {
    if (out.skipped.length < MOST_NAMED) out.skipped.push(`${without(secrets)(path)}: ${why}`); else out.more += 1;
  };
  const walk = (rel: string): void => {
    let names: string[];
    try { names = readdirSync(join(dir, rel)).sort(); } catch { return skip(rel, "could not be read"); }
    for (const name of names) {
      const path = rel ? `${rel}/${name}` : name, full = join(dir, path);
      try {
        const s = lstatSync(full);
        if (holds(asBytes(path))) skip(path, "its name holds a key");
        else if (s.isSymbolicLink()) skip(path, "a link");
        else if (s.isDirectory()) {
          if (LEFT_OUT.has(name)) skip(`${path}/`, "installed or generated");
          else if (isGit(full) && sizeOf(full, limits.totalBytes - total) > limits.totalBytes - total) skip(`${path}/`, "too large");
          else if (isGit(full) && secrets.length && gitHolds(full, secrets)) skip(`${path}/`, "git holds a key, or could not be searched");
          else walk(path);
        } else if (!s.isFile()) skip(path, "not a plain file");
        else if (s.size > limits.fileBytes) skip(path, `${s.size} bytes, over the limit for one file`);
        else if (out.files.length >= limits.files) skip(path, "over the limit on files");
        else if (total + s.size > limits.totalBytes) skip(path, "over the limit on the whole copy");
        else {
          const read = readFileSync(full).toString("latin1");
          if (secrets.length && PACKED.some((m) => read.startsWith(m))) { skip(path, "packed, so it could not be searched for a key"); continue; }
          const bytes = Buffer.from(clean(read), "latin1");
          total += bytes.length;
          out.files.push({ path, bytes, executable: (s.mode & 0o111) !== 0 });
        }
      } catch { skip(path, "could not be read"); }
    }
  };
  walk("");
  return out;
}

export interface KeptRun { task: string; reason: string; check: string; answer?: string; skipped: string[]; more: number }
const ABOUT = "check.json", SECRET = "secret", WORKSPACE = "workspace";

export function writeKept(folder: string, copy: Snapshot, run: Pick<KeptRun, "task" | "reason" | "check" | "answer">, benchSecret: string): void {
  const root = join(folder, WORKSPACE);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  for (const f of copy.files) {
    const path = join(root, f.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, f.bytes);
    if (f.executable) chmodSync(path, 0o755);
  }
  writeFileSync(join(folder, SECRET), benchSecret, { mode: 0o600 });
  writeFileSync(join(folder, ABOUT), `${JSON.stringify({ ...run, skipped: copy.skipped, more: copy.more } satisfies KeptRun, null, 2)}\n`);
}

/** Runs the check of a kept run again, on a copy: a check may write in the folder it looks at, and what was kept stays as it was. */
export async function recheck(folder: string): Promise<CheckResult & { kept: KeptRun }> {
  if (!existsSync(join(folder, ABOUT))) throw new Error(`${folder}: not a kept run (no ${ABOUT})`);
  const kept = JSON.parse(readFileSync(join(folder, ABOUT), "utf8")) as KeptRun;
  const dir = mkdtempSync(join(tmpdir(), "navvied-eval-recheck-"));
  try {
    cpSync(join(folder, WORKSPACE), dir, { recursive: true });
    return { ...(await check(dir, { check: kept.check }, 120_000, scriptEnv({ BENCH_SECRET: readFileSync(join(folder, SECRET), "utf8") }), kept.answer)), kept };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
