/**
 * Facts about the desktop app that must stay true and that no one should have to remember: what a page may call, where the
 * key may be read, which version and identifier the app carries. They read the source as data, so they run anywhere.
 */
import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const HERE = resolve(import.meta.dir, "..");
const read = (p: string) => readFileSync(join(HERE, p), "utf8");
const json = (p: string) => JSON.parse(read(p)) as Record<string, any>;
const COMMANDS = ["page_action", "shell_answer", "shell_settings_get", "shell_settings_set"];

function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (["target", "gen", "node_modules", "binaries"].includes(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* files(p);
    else yield p;
  }
}

test("the app, its crates and the packages share one version", () => {
  const version = json("package.json").version;
  expect(json("src-tauri/tauri.conf.json").version).toBe(version);
  for (const toml of ["core/Cargo.toml", "src-tauri/Cargo.toml"]) expect(/^version = "([^"]+)"/m.exec(read(toml))?.[1]).toBe(version);
});

test("the bundle identifier is written in one place only", () => {
  const holders = [...files(HERE)].filter((f) => !f.endsWith("Cargo.lock") && !/\.(png|ico|icns)$/.test(f) && !f.endsWith("test/desktop.test.ts") && readFileSync(f).includes("com.navvied.desktop")).map((f) => relative(HERE, f));
  expect(holders).toEqual(["src-tauri/tauri.conf.json"]);
});

test("a page can call exactly the commands that were meant: three for the loopback page, one for the pages inside the app", () => {
  const loopback = json("src-tauri/capabilities/loopback.json");
  const local = json("src-tauri/capabilities/local.json");
  expect(readdirSync(join(HERE, "src-tauri/capabilities")).sort()).toEqual(["local.json", "loopback.json"]);
  expect(loopback.remote.urls).toEqual(["http://127.0.0.1:*"]);
  expect([...loopback.permissions].sort()).toEqual(["allow-shell-answer", "allow-shell-settings-get", "allow-shell-settings-set"]);
  expect(local.remote).toBeUndefined();
  expect(local.permissions).toEqual(["allow-page-action"]);
  for (const c of [loopback, local]) expect(c.windows).toEqual(["main"]);
});

test("the commands that exist are the commands that were declared", () => {
  const declared = [...read("src-tauri/build.rs").matchAll(/"([a-z_]+)"/g)].map((m) => m[1]).filter((n) => COMMANDS.includes(n as string));
  expect([...declared].sort()).toEqual(COMMANDS);
  const handler = /generate_handler!\[([^\]]+)\]/.exec(read("src-tauri/src/shell.rs"))?.[1] ?? "";
  expect([...handler.matchAll(/commands::([a-z_]+)/g)].map((m) => m[1]).sort()).toEqual(COMMANDS);
  const defined = [...read("src-tauri/src/commands.rs").matchAll(/#\[tauri::command\]\s*pub fn ([a-z_]+)/g)].map((m) => m[1]).sort();
  expect(defined).toEqual(COMMANDS);
});

test("the pages inside the app cannot reach the network or run inline code", () => {
  const csp: string = json("src-tauri/tauri.conf.json").app.security.csp;
  for (const part of ["default-src 'self'", "script-src 'self'", "connect-src 'none'", "frame-ancestors 'none'", "base-uri 'none'"]) expect(csp).toContain(part);
  for (const page of ["starting.html", "error.html"]) {
    const html = read(`shell-pages/${page}`);
    expect(html).not.toMatch(/<script(?![^>]*\ssrc=)/);
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/\son[a-z]+=/);
  }
  expect(read("shell-pages/page.js")).not.toMatch(/fetch\(|XMLHttpRequest|WebSocket/);
});

test("the overlay builds its cards from text, never from markup", () => {
  const js = read("shell-pages/overlay.js");
  expect([...js.matchAll(/innerHTML/g)].length).toBe(1);
  const template = /root\.innerHTML = `([\s\S]*?)`;/.exec(js)?.[1] ?? "";
  expect(template.length).toBeGreaterThan(100);
  expect(template).not.toContain("${");
  expect(js).not.toMatch(/insertAdjacentHTML|document\.write|eval\(|new Function/);
});

test("the key is read in the few places that must hand it on", () => {
  const hits: string[] = [];
  for (const f of files(join(HERE, "src-tauri/src"))) {
    for (const [i, line] of readFileSync(f, "utf8").split("\n").entries()) if (line.includes(".expose()")) hits.push(`${relative(HERE, f)}:${line.trim()}`);
  }
  expect(hits.length).toBeGreaterThan(0);
  for (const h of hits) expect(/redactor\.add\(token\.expose\(\)\)|serde_json::to_string\(token\.expose\(\)\)|ws::connect\(port, sh\.token\.expose\(\)/.test(h)).toBe(true);
  for (const f of files(join(HERE, "src-tauri/src"))) expect(readFileSync(f, "utf8")).not.toMatch(/println!|eprintln!|dbg!/);
});

test("nothing outside the loopback address is opened by the window", () => {
  const shell = read("src-tauri/src/shell.rs");
  expect(shell).toContain('("http", Some("127.0.0.1")) if port > 0 && url.port() == Some(port) => Nav::Allow');
  expect(existsSync(join(HERE, "src-tauri/icons/tray-template.png"))).toBe(true);
});

test("the test key and the notice switch exist only in builds made for the window tests", () => {
  const shell = read("src-tauri/src/shell.rs").split("\n");
  for (const name of ["NAVVIED_DESKTOP_TEST_KEY", "NAVVIED_DESKTOP_TEST_NOTICE_ALWAYS"]) {
    const at = shell.findIndex((l) => l.includes(name));
    expect(at).toBeGreaterThan(-1);
    expect(shell.slice(Math.max(0, at - 4), at).some((l) => l.includes('feature = "test-hooks"'))).toBe(true);
  }
  const workflow = readFileSync(resolve(HERE, "../../.github/workflows/desktop.yml"), "utf8");
  const section = (name: string) => { const from = workflow.indexOf(`\n  ${name}:`); expect(from).toBeGreaterThan(-1); const rest = workflow.slice(from + 1); const next = rest.slice(1).search(/\n  [a-z]+:\n/); return next < 0 ? rest : rest.slice(0, next + 1); };
  expect(section("window")).toContain("--features test-hooks");
  for (const name of ["core", "bundle", "publish"]) expect(section(name)).not.toContain("test-hooks");
});
