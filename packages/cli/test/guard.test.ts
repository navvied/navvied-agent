import { afterAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Options } from "../src/args.ts";
import { guardCommand } from "../src/commands/guard.ts";
import { guardCommandFor } from "../src/create.ts";
import { fakeIO, remove, tempDir } from "./helpers.ts";

const dirs: string[] = [];
afterAll(() => dirs.forEach(remove));

function run(call: object | string, permissions?: object) {
  const dir = tempDir(); dirs.push(dir);
  const config = join(dir, "config.json");
  writeFileSync(config, JSON.stringify({ models: {}, ...(permissions ? { permissions } : {}) }));
  const f = fakeIO({ stdin: typeof call === "string" ? call : JSON.stringify({ cwd: dir, ...call }) });
  const options = { json: false, yes: false, thinking: false, config } as Options;
  return guardCommand(options, f.io).then((code) => ({ code, err: f.err() }));
}

describe("navvied guard, for a program that runs its own tools", () => {
  test("what is never done is stopped, with the reason for the model, whatever the rules say", async () => {
    const r = await run({ tool_name: "Bash", tool_input: { command: "rm -rf ~" } }, { allow: ["Bash"] });
    expect(r.code).toBe(2);
    expect(r.err).toContain("never does this");
    const system = process.platform === "win32" ? "C:\\Windows\\System32\\drivers\\etc\\hosts" : "/etc/passwd";
    expect((await run({ tool_name: "Write", tool_input: { file_path: system, content: "x" } })).code).toBe(2);
  });
  test("a deny rule stops the tool, and an ask rule stops it saying it needs the person", async () => {
    const rules = { deny: ["Edit(**/.env)"], ask: ["Bash(git push *)"], allow: ["Bash(ls *)"] };
    const denied = await run({ tool_name: "MultiEdit", tool_input: { file_path: "app/.env" } }, rules);
    expect(denied.code).toBe(2);
    expect(denied.err).toContain("permission rule");
    const asked = await run({ tool_name: "Bash", tool_input: { command: "git push origin main" } }, rules);
    expect(asked.code).toBe(2);
    expect(asked.err).toContain("approval");
  });
  test("everything else goes through: allowed and unruled commands, other tools, and input that is not a tool call", async () => {
    expect((await run({ tool_name: "Bash", tool_input: { command: "ls -la" } }, { allow: ["Bash(ls *)"] })).code).toBe(0);
    expect((await run({ tool_name: "Bash", tool_input: { command: "echo hi" } })).code).toBe(0);
    expect((await run({ tool_name: "TodoWrite", tool_input: {} }, { deny: ["Bash"] })).code).toBe(0);
    expect((await run("not json")).code).toBe(0);
  });
});

describe("the command a program runs before its tools", () => {
  test("a compiled navvied calls itself; a script run through bun names the script too; quoting keeps odd paths whole", () => {
    expect(guardCommandFor("/home/a b/config.json", "/work/it's", "linux", "/usr/local/bin/navvied", "/$bunfs/root/navvied")).toBe(`'/usr/local/bin/navvied' guard --config '/home/a b/config.json' --cwd '/work/it'\\''s'`);
    expect(guardCommandFor("/c.json", "/w", "linux", "/usr/bin/bun", "/src/main.ts")).toBe("'/usr/bin/bun' '/src/main.ts' guard --config '/c.json' --cwd '/w'");
    expect(guardCommandFor("C:\\c.json", "C:\\w", "win32", "C:\\navvied.exe", "B:\\~BUN\\root\\navvied.exe")).toBe('"C:\\navvied.exe" guard --config "C:\\c.json" --cwd "C:\\w"');
  });
});
