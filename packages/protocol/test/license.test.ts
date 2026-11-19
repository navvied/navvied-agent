import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../../..");
const SPDX = "PolyForm-Noncommercial-1.0.0";

test("the license file is the PolyForm Noncommercial text, with the required notice", () => {
  const text = readFileSync(join(ROOT, "LICENSE"), "utf8");
  expect(text.startsWith("Required Notice: Copyright (c) 2026 navvied")).toBe(true);
  expect(text).toContain("# PolyForm Noncommercial License 1.0.0");
  for (const section of ["Acceptance", "Copyright License", "Distribution License", "Notices", "Patent License", "Noncommercial Purposes", "Personal Uses", "Patent Defense", "No Liability", "Definitions"]) expect(text).toContain(`## ${section}`);
});

test("the root and every package declare that license, and the README says what it means", () => {
  const manifests = ["package.json", ...readdirSync(join(ROOT, "packages")).map((d) => join("packages", d, "package.json"))];
  for (const m of manifests) expect((JSON.parse(readFileSync(join(ROOT, m), "utf8")) as { license?: string }).license).toBe(SPDX);
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  expect(readme).toContain("source-available");
  expect(readme).toContain("PolyForm Noncommercial License 1.0.0");
});

test("nothing claims the project is open source (saying it is not is fine)", () => {
  for (const file of ["README.md", "CONTRIBUTING.md", "docs/ARCHITECTURE.md", "docs/CLI.md", "docs/INSTALL.md", "docs/EVAL.md", "docs/PROTOCOL.md"]) {
    expect(readFileSync(join(ROOT, file), "utf8")).not.toMatch(/(?<!not )open[- ]source/i);
  }
});
