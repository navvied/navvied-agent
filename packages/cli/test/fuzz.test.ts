import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "../src/args.ts";
import { loadConfig, resolveModel } from "../src/config.ts";
import { expandMentions } from "../src/mentions.ts";
import { garbage, int, mutate, pick, prng, value } from "../../protocol/test/prng.ts";

const dir = mkdtempSync(join(tmpdir(), "navvied-fuzz-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const VALID = { default: "a", models: { a: { baseUrl: "http://h/v1", model: "m", window: 4000, reasoning: "none", headers: { x: "y" } }, b: { command: "agent", args: ["--x"], env: { K: "v" } } } };

test("a configuration file of any content is accepted or rejected with a message, never a crash", () => {
  const r = prng(21);
  const path = join(dir, "c.json");
  let accepted = 0;
  for (let i = 0; i < 1500; i++) {
    const body = r() < 0.15 ? garbage(r) : JSON.stringify(r() < 0.3 ? value(r) : mutate(r, { ...VALID, models: mutate(r, VALID.models as Record<string, unknown>) }));
    writeFileSync(path, body);
    const loaded = loadConfig(path);
    if (!loaded.ok) { expect(loaded.error.length).toBeGreaterThan(0); continue; }
    accepted++;
    const resolved = resolveModel(r() < 0.5 ? undefined : pick(r, ["a", "b", "zzz"]), loaded.value, { NAVVIED_BASE_URL: pick(r, ["", "http://x/v1"]) }, path);
    if (resolved.ok) expect(Boolean(resolved.value.provider) !== Boolean(resolved.value.cli)).toBe(true);
  }
  expect(accepted).toBeGreaterThan(50);
}, 30_000);

test("argument parsing never throws and either yields a command or an error", () => {
  const r = prng(22);
  const tokens = ["run", "chat", "serve", "restore", "--mode", "plan", "--effort", "high", "--session", "x", "--max-steps", "7", "--json", "-y", "--", "--bogus", "-z", "", "task words", "--cwd=/x", "--model", "-m", "=", "--=x"];
  for (let i = 0; i < 4000; i++) {
    const argv = Array.from({ length: int(r, 7) }, () => (r() < 0.1 ? garbage(r) : pick(r, tokens)));
    const result = parseArgs(argv);
    if (result.ok) expect(typeof result.command).toBe("string"); else expect(result.error.length).toBeGreaterThan(0);
  }
});

test("@ mentions never throw, never read outside the folder, and never grow the prompt without bound", () => {
  const r = prng(23);
  writeFileSync(join(dir, "ok.txt"), "contents");
  for (let i = 0; i < 1500; i++) {
    const text = Array.from({ length: int(r, 6) }, () => pick(r, ["@ok.txt", "@../x", "@/etc/passwd", "@", "@@", "text", "@" + garbage(r).replace(/\s/g, ""), "@ok.txt,", "\n"])).join(r() < 0.5 ? " " : "");
    const out = expandMentions(text, dir);
    expect(out.startsWith(text)).toBe(true);
    expect(out.length).toBeLessThan(text.length + 61_000);
    expect(out).not.toContain("root:");
  }
});
