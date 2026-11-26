import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { ROOT, repoFiles } from "./repo-files.ts";

const OTHER_LANGUAGES_ON_PURPOSE = new Set(
  readFileSync(join(import.meta.dir, "other-languages.txt"), "utf8").split("\n").filter(Boolean).map((line) => line.split("\t")[0]),
);

const WORDS = [
  "yang", "tidak", "untuk", "dengan", "adalah", "sudah", "belum", "jangan", "kamu", "saya", "karena", "sebelum", "setelah",
  "kalau", "mohon", "silakan", "tolong", "bahasa", "berhasil", "gagal", "kosong", "salah", "harus", "hapus", "mulai",
  "selesai", "lanjut", "tunggu", "ulang", "sesi", "berkas", "perintah", "pesan", "bisa", "tapi", "juga", "semua", "masih",
  "dulu", "lagi", "sekarang", "nanti", "boleh", "apa", "siapa", "kenapa", "bagaimana", "ada", "baru", "lama", "bagus",
];
const PATTERN = new RegExp(`(^|[^\\p{L}])(${WORDS.join("|")})(?![\\p{L}])`, "iu");

test("source, tests and documentation contain no Indonesian", () => {
  const hits: string[] = [];
  for (const f of repoFiles(ROOT)) {
    if (OTHER_LANGUAGES_ON_PURPOSE.has(relative(ROOT, f).replaceAll(sep, "/"))) continue;
    readFileSync(f, "utf8").split("\n").forEach((line, i) => {
      const m = PATTERN.exec(line);
      if (m) hits.push(`${relative(ROOT, f)}:${i + 1}: "${m[2]}"`);
    });
  }
  expect(hits).toEqual([]);
});

test("commit messages are English", () => {
  const log = Bun.spawnSync(["git", "-C", ROOT, "log", "--format=%an%n%s%n%b"], { stdout: "pipe", stderr: "pipe" });
  const notAGitCheckout = log.exitCode !== 0;
  if (notAGitCheckout) return;
  const hits = new TextDecoder().decode(log.stdout).split("\n").filter((l) => PATTERN.test(l));
  expect(hits).toEqual([]);
});
