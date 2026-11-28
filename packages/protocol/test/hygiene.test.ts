import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, hitsOf } from "./repo-files.ts";

const joinFragments = (fragments: [string, string][]) => fragments.map(([a, b]) => a + b);
const FOREIGN_BRANDS = joinFragments([
  ["her", "mes"], ["cla", "ude"], ["co", "dex"], ["open", "ai"], ["anthr", "opic"], ["gem", "ini"], ["chat", "gpt"],
  ["co", "pilot"], ["gp", "t-"], ["gp", "t5"], ["wind", "surf"], ["ai", "der"],
]);
const NAMING_ALLOWED = new Set(readFileSync(join(import.meta.dir, "naming-allowed.txt"), "utf8").split("\n").filter(Boolean));

test("no foreign brand or product names anywhere in the repository", () => {
  expect(hitsOf(FOREIGN_BRANDS, NAMING_ALLOWED)).toEqual([]);
});

test("the protocol package has no runtime dependencies", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "packages/protocol/package.json"), "utf8")) as { dependencies?: object };
  expect(Object.keys(pkg.dependencies ?? {})).toEqual([]);
});
