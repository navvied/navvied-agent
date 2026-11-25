import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Jobs, defaultTools } from "../src/index.ts";
import type { ToolContext } from "../src/types.ts";
import { stopAllJobs } from "../src/index.ts";
import { HOOK_MS, hook, removeTrees } from "../../protocol/test/support/cleanup.ts";

const made: string[] = [];
const temp = (): string => { const d = mkdtempSync(join(tmpdir(), "navvied-ci3os-")); made.push(d); return d; };
afterAll(hook("ci-3os removes what it made", async () => { await stopAllJobs(); await removeTrees(made); }), HOOK_MS);
const tool = (name: string) => defaultTools().find((t) => t.name === name)!;
const ctx = (cwd: string, more: Partial<ToolContext> = {}): ToolContext => ({ cwd, signal: new AbortController().signal, emit: () => undefined, allowPrivateNetwork: false, jobs: new Jobs(() => undefined), ...more });
const unix = process.platform !== "win32";

describe("a working folder that is spelt through a link (a temporary folder on macOS is behind /var)", () => {
  test.skipIf(!unix)("a command that stays where it started says nothing about the folder, and a cd inside it is told as a folder inside it", async () => {
    const base = temp();
    mkdirSync(join(base, "real", "sub"), { recursive: true });
    symlinkSync(join(base, "real"), join(base, "link"));
    const c = ctx(join(base, "link"), { shell: {} });
    expect(await tool("Bash").run({ command: "echo hi" }, c)).toBe("hi");
    expect(await tool("Bash").run({ command: "cd sub && echo in" }, c)).toBe("in\n[navvied: next commands start in sub]");
    expect(await tool("Bash").run({ command: "pwd | sed 's/.*/same/'" }, c)).toBe("same");
    expect(await tool("Bash").run({ command: "cd .. && echo out" }, c)).toBe("out\n[navvied: next commands start in the working folder]");
    expect(await tool("Bash").run({ command: "cd /tmp && echo away" }, c)).toBe("away\n[navvied: next commands still start in the working folder, a cd outside the project lasts one command]");
  });
});

/** What Grep said, without the line that tells the search was made here instead of by ripgrep. */
const search = async (args: Record<string, unknown>, c: ReturnType<typeof ctx>): Promise<string> => (await tool("Grep").run(args, c)).replace(/\n\[searched without ripgrep:[^\]]*\]$/, "");

describe("the search program's output", () => {
  const log = (n: number): string => Array.from({ length: n }, (_, i) => `2026-11-19T10:00:00Z INFO req-${i.toString(16).padStart(12, "0")} /api/items 500 ${i}ms`).join("\n");

  test("a folder with a very long path costs no matches: the lines are not filled with the path", async () => {
    const dir = temp();
    const deep = join(dir, ...Array.from({ length: 4 }, (_, i) => `a-folder-with-a-rather-long-name-to-fill-the-path-${i}-${"x".repeat(10)}`));
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, "app.log"), log(3000));
    const out = await search({ pattern: " 500 ", path: deep }, ctx(dir));
    const lines = out.split("\n");
    expect(lines).toHaveLength(101);
    expect(lines[0]).toStartWith("app.log:1:");
    expect(lines.at(-1)).toBe("[2900 more matches were not shown: narrow the pattern, add a glob, search one file, or continue with offset 100]");
    // From the project, the path is relative to what was searched, as before.
    expect((await search({ pattern: "req-000000000bb7", path: dir }, ctx(dir))).split("\n")[0]).toMatch(/^a-folder-.*\/app\.log:\d+:/);
  });

  test("a single file is named by its own name", async () => {
    const dir = temp();
    writeFileSync(join(dir, "one.txt"), "alpha\nbeta needle\n");
    expect(await search({ pattern: "needle", path: join(dir, "one.txt") }, ctx(dir))).toBe("one.txt:2:beta needle");
  });

  test.skipIf(!unix)("a line the program prints about something else is not taken for a match, and does not change how the rest is shown; a pattern the program refuses is an error", async () => {
    const dir = temp(), bin = temp();
    writeFileSync(join(dir, "app.log"), log(300));
    // A search program that complains on its error output first, as some do about a file it may not read.
    const real = Bun.which("grep")!;
    // It takes the pattern after -e and the place searched from the end of what it is told, whatever else it is told.
    writeFileSync(join(bin, "rg"), `#!/bin/sh\necho "rg: some/other/file: Permission denied (os error 13)" >&2\nfor last; do :; done\nwhile [ $# -gt 0 ]; do [ "$1" = "-e" ] && pattern=$2; shift; done\nexec ${real} -rnHE --exclude-dir=.git -e "$pattern" "$last" 2>&1\n`);
    chmodSync(join(bin, "rg"), 0o755);
    const before = process.env.PATH;
    process.env.PATH = `${bin}:${before}`;
    try {
      const out = await search({ pattern: " 500 ", path: dir }, ctx(dir));
      const lines = out.split("\n");
      expect(lines).toHaveLength(101);
      expect(lines.every((l, i) => i === 100 || /^app\.log:\d+:/.test(l))).toBe(true);
      expect(lines.at(-1)).toBe("[200 more matches were not shown: narrow the pattern, add a glob, search one file, or continue with offset 100]");
    } finally { process.env.PATH = before; }
    const refused = await tool("Grep").run({ pattern: "(unclosed", path: dir }, ctx(dir));
    expect(refused).toStartWith("Error: ");
  });
});
