/**
 * Repository hygiene: this codebase carries the navvied brand only. No other vendor, product or model-family name may
 * appear in code, tests, docs or configuration. The terms are assembled from fragments so this file does not match itself.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { ROOT, repoFiles } from "./repo-files.ts";

const FRAGMENTS: [string, string][] = [
  ["her", "mes"], ["cla", "ude"], ["co", "dex"], ["open", "ai"], ["anthr", "opic"], ["gem", "ini"], ["chat", "gpt"],
  ["co", "pilot"], ["gp", "t-"], ["gp", "t5"], ["wind", "surf"], ["ai", "der"],
];
const BANNED = FRAGMENTS.map(([a, b]) => a + b);
const SKIP = new Set(["bun.lock", "bun.lockb"]);
/** Files that name outside services on purpose: the service presets, so a newcomer can pick theirs, and the code that talks to those services. */
const NAMING_ALLOWED = new Set(readFileSync(join(import.meta.dir, "naming-allowed.txt"), "utf8").split("\n").filter(Boolean));


test("no foreign brand or product names anywhere in the repository", () => {
  const hits: string[] = [];
  for (const f of repoFiles(ROOT, SKIP)) {
    const text = readFileSync(f, "utf8").toLowerCase();
    const path = relative(ROOT, f).replaceAll(sep, "/");
    if (NAMING_ALLOWED.has(path)) continue;
    for (const term of BANNED) {
      if (text.includes(term) || path.toLowerCase().includes(term)) hits.push(`${path}: "${term}"`);
    }
  }
  expect(hits).toEqual([]);
});

test("the protocol package has no runtime dependencies", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "packages/protocol/package.json"), "utf8")) as { dependencies?: object };
  expect(Object.keys(pkg.dependencies ?? {})).toEqual([]);
});
