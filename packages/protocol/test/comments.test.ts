import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../../..");
const SKIP = new Set(["node_modules", ".worktrees", ".git", "dist", "bun.lock", "bun.lockb", "comments.test.ts"]);

function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* sources(path);
    else if (/\.(ts|json|md)$/.test(name)) yield path;
  }
}

const RULES: [string, RegExp][] = [
  ["decorative divider", /^\s*(\/\/|\*)\s*[-=─━_*#~]{4,}/],
  ["commented-out code", /^\s*\/\/\s*(const|let|var|import|export|function|return|await|if \(|for \(|while \()\b/],
  ["unowned marker", /\b(TODO|FIXME|XXX|HACK)\b/],
  ["trailing whitespace", /[ \t]+$/],
];

test("source files carry no decorative dividers, commented-out code, stray markers or trailing whitespace", () => {
  const hits: string[] = [];
  for (const file of sources(ROOT)) {
    if (file.endsWith(".md")) continue;
    readFileSync(file, "utf8").split("\n").forEach((line, i) => {
      for (const [name, rule] of RULES) if (rule.test(line)) hits.push(`${relative(ROOT, file)}:${i + 1}: ${name}`);
    });
  }
  expect(hits).toEqual([]);
});

test("a comment never merely restates the line it sits on", () => {
  const hits: string[] = [];
  for (const file of sources(ROOT)) {
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
