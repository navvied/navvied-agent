/**
 * Facts about the desktop app that must stay true and that no one should have to remember: what a page may call, where the
 * key may be read, which version and identifier the app carries. They read the source as data, so they run anywhere.
 */
import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const HERE = resolve(import.meta.dir, "..");
const read = (p: string) => readFileSync(join(HERE, p), "utf8");
const json = (p: string) => JSON.parse(read(p)) as Record<string, any>;
const COMMANDS = ["clipboard_image", "page_action", "relay_answer", "relay_forget", "relay_pair", "relay_status", "shell_answer", "shell_settings_get", "shell_settings_set"];

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
  const holders = [...files(HERE)].map((f) => relative(HERE, f).replaceAll(sep, "/")).filter((f) => !f.endsWith("Cargo.lock") && !/\.(png|ico|icns)$/.test(f) && f !== "test/desktop.test.ts" && readFileSync(join(HERE, f)).includes("com.navvied.desktop"));
  expect(holders).toEqual(["src-tauri/tauri.conf.json"]);
});

test("a page can call exactly the commands that were meant: eight for the loopback page (the three it always had, the clipboard fallback for an image paste, plus pairing with navvied.com over the relay), one for the pages inside the app", () => {
  const loopback = json("src-tauri/capabilities/loopback.json");
  const local = json("src-tauri/capabilities/local.json");
  expect(readdirSync(join(HERE, "src-tauri/capabilities")).sort()).toEqual(["local.json", "loopback.json"]);
  expect(loopback.remote.urls).toEqual(["http://127.0.0.1:*"]);
  expect([...loopback.permissions].sort()).toEqual([
    "allow-clipboard-image", "allow-relay-answer", "allow-relay-forget", "allow-relay-pair", "allow-relay-status", "allow-shell-answer", "allow-shell-settings-get", "allow-shell-settings-set",
  ]);
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
  for (const h of hits) expect(/redactor\.add\(token\.expose\(\)\)|serde_json::to_string\(token\.expose\(\)\)|ws::connect\(port, sh\.token\.expose\(\)|http::(get|post)\(port, path, Some\(sh\.token\.expose\(\)\)/.test(h)).toBe(true);
  for (const f of files(join(HERE, "src-tauri/src"))) expect(readFileSync(f, "utf8")).not.toMatch(/println!|eprintln!|dbg!/);
});

test("the sidecar is started before the window is built, so neither waits on the other", () => {
  const setup = read("src-tauri/src/shell.rs").match(/fn setup\(app: &AppHandle\)[\s\S]*?\n\}/)?.[0] ?? "";
  expect(setup).toMatch(/start_supervisor\(app, &shell\);[\s\S]*create_window\(app, &shell/);
});

test("a file dropped, pasted or picked on the page reaches the page itself, not a native screen of its own", () => {
  const shell = read("src-tauri/src/shell.rs");
  // WebKitGTK gives a dropped file to the page only as a text/uri-list string, never a File (verified with the
  // real WebKit remote inspector): Tauri's own drag-drop handler stays on (not .disable_drag_drop_handler()) so
  // Rust can read the real paths, and native_drag_drop hands them back to the page as a synthetic HTML5 drop.
  expect(shell).not.toContain(".disable_drag_drop_handler()");
  expect(shell).toContain("fn native_drag_drop(");
  expect(shell).toContain("window.__navviedDrop");
  expect(shell).toContain(".enable_clipboard_access()");
  // The File/Edit/Window menu bar Menu::default() draws is a visible change on Linux and Windows (no preview
  // approved for it); only macOS needs it at all, to get the Cmd+V accelerator the system requires for paste.
  const menuAt = shell.split("\n").findIndex((l) => l.includes("tauri::menu::Menu::default(handle)"));
  expect(menuAt).toBeGreaterThan(-1);
  expect(shell.split("\n").slice(Math.max(0, menuAt - 3), menuAt).some((l) => l.includes('target_os = "macos"'))).toBe(true);
});

test("a drop's position is only converted to logical pixels on Windows — on Linux and macOS it already is one", () => {
  // Reading wry's own source per platform (its doc comment right above this, in shell.rs, cites the exact
  // functions): Windows gives a real physical pixel needing to_logical(scale_factor); Linux (GTK's drag-motion)
  // and macOS (AppKit's draggingLocation) already hand over the logical/points equivalent. Converting those two
  // a second time was reproduced as a real bug (a drop aimed at logical (685,600) landed at (342.5,300) under
  // GDK_SCALE=2) and is exactly what this guards against reappearing.
  const shell = read("src-tauri/src/shell.rs");
  const fn = shell.match(/fn native_drag_drop\([\s\S]*?\n}\n/)?.[0] ?? "";
  expect(fn).toContain('#[cfg(windows)]');
  expect(fn).toMatch(/#\[cfg\(windows\)\]\s*\n\s*let logical[\s\S]*?to_logical/);
  expect(fn).toMatch(/#\[cfg\(not\(windows\)\)\]\s*\n\s*let logical[\s\S]*?LogicalPosition::new\(p\.x, p\.y\)/);
});

test("a paste with no file of its own (WebKitGTK gives the page no image clipboard target at all) can still ask for one", () => {
  const shell = read("src-tauri/src/shell.rs");
  expect(shell).toContain("pub fn clipboard_image(");
  expect(read("src-tauri/src/commands.rs")).toContain("pub fn clipboard_image(");
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

/** The source range of one top-level `fn <name>`'s body, braces included, found by counting from its opening `{`. */
function functionBody(src: string, name: string): { start: number; end: number; body: string } {
  const at = new RegExp(`\\bfn ${name}\\s*[(<]`).exec(src);
  if (!at) throw new Error(`fn ${name} not found in shell.rs`);
  const start = src.indexOf("{", at.index);
  if (start < 0) throw new Error(`fn ${name} has no body`);
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return { start, end: i + 1, body: src.slice(start, i + 1) };
  }
  throw new Error(`fn ${name}'s braces never balance`);
}

test("every touch of the window or the tray runs on the GTK main thread", () => {
  // `run_on_main_thread` runs its closure inline when already on that thread (tauri-runtime-wry's
  // send_user_message checks this) and marshals it there otherwise, so it is always correct to call —
  // the HiDPI hang this guards against was exactly a `navigate()` call made straight from the supervisor's
  // own worker thread, one that returned Ok while the page never changed (fixed in apps/hidpi-start).
  // Rather than trying to prove, call by call, which thread each of this file's many callers happens to run
  // on, every real touch of the window (`w.<method>`) or the tray (`t.<method>`) is confined to one of the
  // functions below, and each of those (but for the two explicitly exempted, which are provably already on
  // the main thread) must itself dispatch through `run_on_main_thread`.
  const shell = read("src-tauri/src/shell.rs");
  const MUST_WRAP = ["running", "show_window", "hide_window", "overlay", "overlay_fill", "go", "confirm_navigated", "refresh_tray", "set_tray_login"];
  // native_drag_drop: fired from `WindowEvent::DragDrop`, a window event tao dispatches on the main thread,
  // same as `on_window_event`'s other branches just above it in `create_window`.
  // window_in_front: has to return a `bool` to its caller, which `run_on_main_thread` cannot do; its own
  // doc comment restricts it to being called only from a closure `dispatch` has already put on the main
  // thread (`Update::Notice`), so it reads the window directly instead of dispatching a second time.
  const EXEMPT = ["native_drag_drop", "window_in_front"];
  const ranges = [...MUST_WRAP, ...EXEMPT].map((name) => ({ name, ...functionBody(shell, name) }));
  for (const name of MUST_WRAP) expect(ranges.find((r) => r.name === name)?.body).toContain("run_on_main_thread");
  const RISKY = [/\bw\.navigate\(/g, /\bw\.eval\(/g, /\bw\.url\(\)/g, /\bw\.show\(\)/g, /\bw\.hide\(\)/g, /\bw\.unminimize\(\)/g, /\bw\.set_focus\(\)/g, /\bw\.is_visible\(\)/g, /\bw\.is_focused\(\)/g, /\bt\.set\(/g, /\bt\.set_login\(/g];
  const offenders: string[] = [];
  for (const re of RISKY) {
    for (const m of shell.matchAll(re)) {
      const at = m.index ?? -1;
      if (!ranges.some((r) => at >= r.start && at < r.end)) {
        offenders.push(`${shell.slice(0, at).split("\n").length}: ${m[0]}`);
      }
    }
  }
  expect(offenders).toEqual([]);
});

test("a macOS disk image is never made by attaching one: the bundler is asked for the app only, and the script that makes the image has no attach", () => {
  const workflow = readFileSync(resolve(HERE, "../../.github/workflows/desktop.yml"), "utf8");
  expect(workflow).not.toMatch(/bundles: "[^"]*dmg/);
  expect(workflow).toContain("scripts/make-dmg.sh");
  const script = readFileSync(join(HERE, "scripts/make-dmg.sh"), "utf8").split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
  expect(script).toContain("hdiutil makehybrid");
  expect(script).not.toMatch(/hdiutil (attach|create|mount)/);
});
