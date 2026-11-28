import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { HOOK_MS, hook, removeTree } from "../../protocol/test/support/cleanup.ts";
import { McpClient } from "../src/mcp.ts";
import { ChildEnv, spawn, type ChildProcess } from "../src/process-start.ts";
import { launch } from "../src/tools/browser/launch.ts";

const ROOT = join(import.meta.dir, "..", "..");
const PRODUCT = ["engine", "cli", "stream-engine", "protocol"];
const ONE_DOOR = "engine/src/process-start.ts";
const sources = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sources(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []));

const TYPE_ONLY_IMPORT = /^import type [^;]*?from ["']node:child_process["'];?$/gm;
const WAYS_AROUND: readonly RegExp[] = [
  /["'`](node:)?child_process["'`]/,
  /\bBun\s*\??\.\s*(spawn(Sync)?(?![\w])|\$(?![\w{]))/,
  /\bBun\s*\??\.?\s*\[/,
  /[=:]\s*Bun\s*(?=[;,)\n}]|$)/m,
  /(import|export)\s*\{[^}]*(\$|\bspawn(Sync)?\b)[^}]*\}\s*from\s*["']bun["']/,
  /(import|export)\s*\*(\s*as\s+[\w$]+)?\s*from\s*["']bun["']/,
  /import\s+(?!type\b)[\w$]+\s*(,\s*\{[^}]*\}\s*)?from\s*["']bun["']/,
  /\b(import|require)\s*\(\s*["'`]bun["'`]\s*\)/,
];
const startsByItself = (source: string): boolean => { const code = source.replace(TYPE_ONLY_IMPORT, ""); return WAYS_AROUND.some((way) => way.test(code)); };
const productFiles = (): string[] => PRODUCT.flatMap((p) => sources(join(ROOT, p, "src"))).map((f) => relative(ROOT, f).replaceAll("\\", "/")).filter((f) => !f.endsWith("web-assets.ts"));
const textOf = (file: string): string => readFileSync(join(ROOT, file), "utf8");

describe("programs are started through one door", () => {
  test("the check itself sees every way of starting a process, and lets a type-only import pass", () => {
    const around = [
      'import { spawn } from "child_process";', "import { spawn } from 'node:child_process';", 'export { execSync } from "node:child_process";', 'const cp = await import("node:child_process");', 'const cp = require(`child_process`);',
      'import { $ } from "bun";', 'import { spawn } from "bun";', 'Bun["spawn"](["x"]);', "Bun?.spawnSync([]);", "Bun.spawn ([]);", "await Bun.$`env`;", "const { spawn } = Bun;", "const b = Bun;",
      'import * as b from "bun"; b.spawn(["x"]);', 'export { spawn as two } from "bun";', 'export * from "bun";', '(await import("bun")).spawn(["x"]);', 'const b = require("bun");', 'import b from "bun";',
      'import type { ChildProcess } from "node:child_process";\nimport { exec } from "node:child_process";',
    ];
    expect(around.filter((code) => !startsByItself(code))).toEqual([]);
    expect(['import type { ChildProcess } from "node:child_process";', 'const found = Bun.which("git");', "Bun.sleep(1);", "const a: Bun.Subprocess = x;", "const p = bunSpawn([]);"].filter(startsByItself)).toEqual([]);
  });

  test("no other file of the product starts a process by itself, so none can hand over keys by forgetting to remove them", () => {
    expect(productFiles().filter((f) => f !== ONE_DOOR && startsByItself(textOf(f)))).toEqual([]);
  });

  test("only navvied starting itself is handed this program's whole environment", () => {
    expect(productFiles().filter((f) => textOf(f).includes("forNavvied(")).sort()).toEqual(["cli/src/schedule-run.ts", ONE_DOOR].sort());
  });

  test("a whole process environment is not accepted as an addition: the type check refuses it", () => {
    type Added = Parameters<ChildEnv["with"]>[0];
    const refused: NodeJS.ProcessEnv extends NonNullable<Added> ? false : true = true;
    expect(refused).toBe(true);
  });
});

const KEY_NAME = "NAVVIED_PROBE_API_KEY", VALUE_UNDER_A_PLAIN_NAME = "NAVVIED_PROBE_PLAIN", SIGN_IN = "NAVVIED_PROBE_SIGNIN_TOKEN";
const PROXY_WITH_PASSWORD = "http://someone:probe-proxy-password@proxy.example:3128";
const secrets = { [KEY_NAME]: "probe-key-0123456789abcdef", [SIGN_IN]: "probe-signin-0123456789abcdef", NAVVIED_PROBE_AUTH: "probe-auth-0123456789abcdef", [VALUE_UNDER_A_PLAIN_NAME]: "probe-key-0123456789abcdef", NAVVIED_PROBE_FINE: "yes" };
const dir = mkdtempSync(join(tmpdir(), "navvied-onedoor-"));
beforeAll(() => { Object.assign(process.env, secrets); });
afterAll(hook("process-start removes what it made", async () => { for (const name of Object.keys(secrets)) delete process.env[name]; await removeTree(dir); }), HOOK_MS);

const recorder = (name: string): { script: string; seen: () => string[] } => {
  const out = join(dir, `${name}.env`), script = join(dir, `${name}.sh`);
  writeFileSync(script, `#!/bin/sh\nenv > ${JSON.stringify(out)}.part && mv ${JSON.stringify(out)}.part ${JSON.stringify(out)}\n`);
  chmodSync(script, 0o755);
  return { script, seen: () => readFileSync(out, "utf8").split("\n").map((l) => l.split("=")[0]!).filter((n) => n.startsWith("NAVVIED_PROBE") || n === "PATH") };
};
const finished = (child: ChildProcess): Promise<void> => new Promise((resolve) => { child.once("close", () => resolve()); });

describe.skipIf(process.platform === "win32")("what a started program is given", () => {
  test("by default, none of this program's keys: not by a secret's name, not the same value under a plain name", async () => {
    const r = recorder("default");
    await finished(spawn(r.script, [], { stdio: "ignore" }));
    expect(r.seen().sort()).toEqual(["NAVVIED_PROBE_FINE", "PATH"]);
  });

  test("a program the person signed in to gets its own sign-in variables and what its entry sets, and nothing else secret", async () => {
    const r = recorder("signin");
    await finished(spawn(r.script, [], { stdio: "ignore", env: ChildEnv.scrubbed(process.env, { keep: [SIGN_IN] }).with({ NAVVIED_PROBE_SET_BY_ENTRY: "1" }) }));
    expect(r.seen().sort()).toEqual(["NAVVIED_PROBE_FINE", "NAVVIED_PROBE_SET_BY_ENTRY", SIGN_IN, "PATH"]);
  });

  test("a connected program starts from a short list of the computer's own variables, plus what its configuration names", async () => {
    const r = recorder("server");
    await McpClient.start("probe", { command: r.script, env: { NAVVIED_PROBE_NAMED: "1" } }).then((c) => c.close(), () => undefined);
    expect(r.seen().sort()).toEqual(["NAVVIED_PROBE_NAMED", "PATH"]);
  });

  test("a browser is started without the keys", async () => {
    const r = recorder("browser");
    await expect(launch(r.script, 1)).rejects.toThrow("the browser stopped while starting");
    expect(r.seen().sort()).toEqual(["NAVVIED_PROBE_FINE", "PATH"]);
  });
});

describe("a proxy address with a password", () => {
  const given = { PATH: "/bin", HTTPS_PROXY: PROXY_WITH_PASSWORD, http_proxy: "someone:probe-proxy-password@proxy.example:3128", ALL_PROXY: "socks5://u:probe-proxy-password@[::1]:1080", HTTP_PROXY: "http://proxy.example:3128", NO_PROXY: "localhost,.example" };

  test("reaches a connected program without the user name and password, in every spelling", () => {
    expect(ChildEnv.forServer(given).vars).toEqual({ PATH: "/bin", HTTPS_PROXY: "http://proxy.example:3128", http_proxy: "proxy.example:3128", ALL_PROXY: "socks5://[::1]:1080", HTTP_PROXY: "http://proxy.example:3128", NO_PROXY: "localhost,.example" });
  });

  test("a password written with a slash or a number sign, which hides the user name from any reading of the address, is not passed on in any form", () => {
    for (const address of ["http://user:12/s3cret@proxy:3128", "http://user:12#s3cret@proxy:3128", "user:12?s3cret@proxy:3128"]) expect(ChildEnv.forServer({ HTTPS_PROXY: address }).vars, address).toEqual({});
  });

  test("one that cannot be read is not passed at all, and the whole address is what the program gets when its configuration names it", () => {
    expect(ChildEnv.forServer({ HTTPS_PROXY: "http://u:p@[broken" }).vars).toEqual({});
    expect(ChildEnv.forServer(given).with({ HTTPS_PROXY: PROXY_WITH_PASSWORD }).vars.HTTPS_PROXY).toBe(PROXY_WITH_PASSWORD);
  });
});
