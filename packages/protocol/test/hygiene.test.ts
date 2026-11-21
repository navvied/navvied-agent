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
const NAMING_ALLOWED = new Set(["packages/cli/src/presets.ts", "packages/cli/test/presets.test.ts", "packages/cli/test/known-effort.test.ts", "packages/protocol/test/hygiene.test.ts", "packages/engine/src/providers/messages-api.ts", "packages/stream-engine/src/codex-engine.ts", "packages/stream-engine/src/codex-translate.ts", "packages/stream-engine/src/index.ts", "packages/stream-engine/test/codex-engine.test.ts", "packages/stream-engine/test/codex-translate.test.ts", "packages/cli/src/config.ts", "packages/cli/src/create.ts", "packages/engine/src/signin-program.ts", "packages/cli/src/logins.ts", "packages/cli/test/logins.test.ts", "packages/engine/src/signin.ts", "packages/engine/test/messages-api.test.ts"]);


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
