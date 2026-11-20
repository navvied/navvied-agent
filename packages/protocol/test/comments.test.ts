import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { ROOT, repoFiles } from "./repo-files.ts";

const SKIP = new Set(["bun.lock", "bun.lockb", "comments.test.ts"]);

function* sources(): Generator<string> {
  for (const p of repoFiles(ROOT, SKIP)) if (/\.(ts|json|md)$/.test(p)) yield p;
}

const RULES: [string, RegExp][] = [
  ["decorative divider", /^\s*(\/\/|\*)\s*[-=─━_*#~]{4,}/],
  ["commented-out code", /^\s*\/\/\s*(const|let|var|import|export|function|return|await|if \(|for \(|while \()\b/],
  ["unowned marker", /\b(TODO|FIXME|XXX|HACK)\b/],
  ["trailing whitespace", /[ \t]+$/],
];

test("source files carry no decorative dividers, commented-out code, stray markers or trailing whitespace", () => {
  const hits: string[] = [];
  for (const file of sources()) {
    if (file.endsWith(".md")) continue;
    readFileSync(file, "utf8").split("\n").forEach((line, i) => {
      for (const [name, rule] of RULES) if (rule.test(line)) hits.push(`${relative(ROOT, file)}:${i + 1}: ${name}`);
    });
  }
  expect(hits).toEqual([]);
});

test("a comment never merely restates the line it sits on", () => {
  const hits: string[] = [];
  for (const file of sources()) {
    if (!file.endsWith(".ts")) continue;
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      const m = /^\s*\/\/\s*(.*)$/.exec(line);
      const next = lines[i + 1]?.trim() ?? "";
      if (!m || !m[1] || !next) return;
      const words = m[1].toLowerCase().match(/[a-z]{4,}/g) ?? [];
      const code = next.toLowerCase();
      if (words.length >= 2 && words.every((w) => code.includes(w))) hits.push(`${relative(ROOT, file)}:${i + 1}: "${m[1]}"`);
    });
  }
  expect(hits).toEqual([]);
});
