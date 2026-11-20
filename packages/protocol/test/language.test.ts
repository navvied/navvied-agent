/**
 * Language hygiene: code, comments, tests, documentation, identifiers and commit messages are English only.
 * A word list of distinctive non-English words (Indonesian) is scanned for; typical English words that merely look
 * similar are left out to avoid false positives.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { ROOT, repoFiles } from "./repo-files.ts";

const SKIP_FILES = new Set(["language.test.ts", "export-public.sh", "bun.lock", "bun.lockb", "Cargo.lock"]);

const WORDS = [
  "tuan", "bos", "yang", "tidak", "untuk", "dengan", "adalah", "sudah", "belum", "jangan", "kamu", "saya", "karena", "sebelum", "setelah",
  "kalau", "mohon", "silakan", "tolong", "bahasa", "berhasil", "gagal", "kosong", "salah", "harus", "hapus", "mulai",
  "selesai", "lanjut", "tunggu", "ulang", "sesi", "berkas", "perintah", "pesan", "bisa", "tapi", "juga", "semua", "masih",
  "dulu", "lagi", "sekarang", "nanti", "boleh", "apa", "siapa", "kenapa", "bagaimana", "ada", "baru", "lama", "bagus",
];
const PATTERN = new RegExp(`(^|[^\\p{L}])(${WORDS.join("|")})(?![\\p{L}])`, "iu");


test("source, tests and documentation contain no Indonesian", () => {
  const hits: string[] = [];
  for (const f of repoFiles(ROOT, SKIP_FILES)) {
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
