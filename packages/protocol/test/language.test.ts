/**
 * Language hygiene: code, comments, tests, documentation, identifiers and commit messages are English only.
 * A word list of distinctive non-English words (Indonesian) is scanned for; typical English words that merely look
 * similar are left out to avoid false positives.
 */
import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../../..");
const SKIP_DIRS = new Set(["node_modules", ".worktrees", ".git", "dist", "target"]);
const SKIP_FILES = new Set(["language.test.ts", "export-public.sh", "bun.lock", "bun.lockb", "Cargo.lock"]);

const WORDS = [
  "tuan", "bos", "yang", "tidak", "untuk", "dengan", "adalah", "sudah", "belum", "jangan", "kamu", "saya", "karena", "sebelum", "setelah",
  "kalau", "mohon", "silakan", "tolong", "bahasa", "berhasil", "gagal", "kosong", "salah", "harus", "hapus", "mulai",
  "selesai", "lanjut", "tunggu", "ulang", "sesi", "berkas", "perintah", "pesan", "bisa", "tapi", "juga", "semua", "masih",
  "dulu", "lagi", "sekarang", "nanti", "boleh", "apa", "siapa", "kenapa", "bagaimana", "ada", "baru", "lama", "bagus",
];
const PATTERN = new RegExp(`(^|[^\\p{L}])(${WORDS.join("|")})(?![\\p{L}])`, "iu");

function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name) || SKIP_FILES.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* files(p);
    else if (st.size < 2_000_000) yield p;
  }
}

test("source, tests and documentation contain no Indonesian", () => {
  const hits: string[] = [];
  for (const f of files(ROOT)) {
    readFileSync(f, "utf8").split("\n").forEach((line, i) => {
      const m = PATTERN.exec(line);
      if (m) hits.push(`${relative(ROOT, f)}:${i + 1}: "${m[2]}"`);
    });
  }
  expect(hits).toEqual([]);
});

test("commit messages are English", () => {
  const log = Bun.spawnSync(["git", "-C", ROOT, "log", "--format=%an%n%s%n%b"], { stdout: "pipe", stderr: "pipe" });
  if (log.exitCode !== 0) return; // not a git checkout (an exported tarball): nothing to scan
  const hits = new TextDecoder().decode(log.stdout).split("\n").filter((l) => PATTERN.test(l));
  expect(hits).toEqual([]);
});
