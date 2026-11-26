import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browser, closeBrowser, findChrome } from "../src/index.ts";
import { browserHere, devToolsEndpoint, openWithRetry } from "../src/tools/browser.ts";
import { stopAllJobs } from "../src/index.ts";
import { HOOK_MS, hook, removeTree } from "../../protocol/test/support/cleanup.ts";

const chrome = findChrome();
const site = Bun.serve({
  port: 0,
  fetch(req) {
    const u = new URL(req.url);
    const page = (body: string, title = "Shop") => new Response(`<!doctype html><title>${title}</title><body>${body}</body>`, { headers: { "content-type": "text/html" } });
    if (u.pathname === "/about") return page("<h1>About us</h1><p>We sell lamps.</p><a href='/'>Home</a>", "About");
    if (u.pathname === "/search") return page(`<h1>Results for ${u.searchParams.get("q")} in ${u.searchParams.get("color")}</h1>`, "Results");
    return page(`<h1>Welcome to the shop</h1><p>${"Lamps and more. ".repeat(10)}</p><a href="/about">About</a><a href="/private">Links</a>
      <form action="/search"><input name="q" placeholder="Search lamps"><select name="color"><option value="red">Red</option><option value="blue">Blue</option></select><button type="submit">Go</button></form>
      <div style="height:3000px"></div><p id="bottom">The very end</p>`);
  },
});
afterAll(() => { closeBrowser(); site.stop(true); });

const ctx = { cwd: "/", signal: new AbortController().signal, emit() {}, allowPrivateNetwork: true } as never;
const home = `http://127.0.0.1:${site.port}/`;
const run = (a: Record<string, unknown>, allowPrivate = true) => browser.run(a, { ...(ctx as object), allowPrivateNetwork: allowPrivate } as never);

describe("finding a browser", () => {
  test("the path in NAVVIED_CHROME wins, then the usual places for the system, and nothing is found where there is none", () => {
    expect(findChrome({ NAVVIED_CHROME: "/x/chrome" }, "linux", (p) => p === "/x/chrome", () => null)).toBe("/x/chrome");
    expect(findChrome({}, "darwin", (p) => p.includes("Chromium"), () => null)).toBe("/Applications/Chromium.app/Contents/MacOS/Chromium");
    expect(findChrome({}, "linux", () => false, (c) => (c === "chromium" ? "/usr/bin/chromium" : null))).toBe("/usr/bin/chromium");
    expect(findChrome({}, "win32", (p) => p.includes("msedge") && p.includes("Program Files\\"), () => null)).toContain("msedge.exe");
    expect(findChrome({}, "linux", () => false, () => null)).toBeUndefined();
  });
  test("a model with room is offered it where a browser is, whatever the request says; a small one finds it by name", () => {
    expect(browser.offeredWhen!({ small: false, jobs: 0 })).toBe(browserHere());
    expect(browser.offeredWhen!({ small: true, jobs: 0 })).toBe(false);
  });
});

describe.skipIf(!chrome || process.platform === "win32")("a browser that stops while starting", () => {
  const dir = mkdtempSync(join(tmpdir(), "navvied-fakechrome-"));
  afterAll(hook("browser removes what it made", async () => { await stopAllJobs(); await removeTree(dir); }), HOOK_MS);
  const withBrowser = async <T,>(script: string, body: () => Promise<T>): Promise<T> => {
    const file = join(dir, `chrome-${Math.random().toString(36).slice(2)}`);
    writeFileSync(file, `#!/bin/sh\n${script}\n`);
    chmodSync(file, 0o755);
    const before = process.env.NAVVIED_CHROME;
    process.env.NAVVIED_CHROME = file;
    closeBrowser();
    try { return await body(); } finally { closeBrowser(); if (before === undefined) delete process.env.NAVVIED_CHROME; else process.env.NAVVIED_CHROME = before; }
  };

  test("it is started so that its throwaway profile never asks for the person's keychain or keyring", async () => {
    const seen = join(dir, "flags.txt");
    await withBrowser(`printf '%s\\n' "$@" > ${JSON.stringify(seen)}; exit 3`, () => run({ action: "open", url: home }));
    const flags = readFileSync(seen, "utf8").split("\n");
    expect(flags).toContain("--use-mock-keychain");
    expect(flags).toContain("--password-store=basic");
  });

  test("the answer says it stopped, with its exit code and its last words, at once rather than after 15 s", async () => {
    const started = Date.now();
    const out = await withBrowser('echo "cannot open display" >&2; exit 3', () => run({ action: "open", url: home }));
    expect(out).toContain("the browser stopped while starting (exit 3): cannot open display");
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 30_000);

  test("one that never writes its port is said to be still running, with what its profile held and what it said", async () => {
    const before = process.env.NAVVIED_BROWSER_START_MS;
    process.env.NAVVIED_BROWSER_START_MS = "1500";
    try {
      const out = await withBrowser('echo "warming up" >&2; sleep 30', () => run({ action: "open", url: home }));
      expect(out).toMatch(/the browser did not start in 2 s \(still running; profile: .*; said: warming up\)/);
    } finally { if (before === undefined) delete process.env.NAVVIED_BROWSER_START_MS; else process.env.NAVVIED_BROWSER_START_MS = before; }
  }, 30_000);

  test("one that stopped once is started again, and the second start is the one used", async () => {
    const marker = join(dir, `started-${Math.random().toString(36).slice(2)}`);
    const out = await withBrowser(`if [ ! -e "${marker}" ]; then : > "${marker}"; echo "crashed" >&2; exit 139; fi\nexec "${chrome}" "$@"`, () => run({ action: "open", url: home }));
    expect(out).toContain("Welcome to the shop");
  }, 45_000);

  test("a port file that is there before it is whole (empty, or the port without its address) is waited for, not used", async () => {
    // The browser writes the file in more than one step; this one leaves it empty for a moment and then starts the real browser.
    const script = `for a in "$@"; do case "$a" in --user-data-dir=*) d="\${a#--user-data-dir=}"; esac; done\n: > "$d/DevToolsActivePort"\nsleep 0.7\nprintf '9' > "$d/DevToolsActivePort"\nsleep 0.7\nexec "${chrome}" "$@"`;
    const out = await withBrowser(script, () => run({ action: "open", url: home }));
    expect(out).toContain("Welcome to the shop");
  }, 45_000);
});

describe("where the browser says it listens", () => {
  const file = join(mkdtempSync(join(tmpdir(), "navvied-port-")), "DevToolsActivePort");
  const write = (text: string): void => writeFileSync(file, text);
  test("only a file with the port and the address is an answer", () => {
    expect(devToolsEndpoint(join(tmpdir(), "navvied-no-such-file"))).toBeUndefined();
    for (const half of ["", "9222", "9222\n", "\n/devtools/browser/x", "abc\n/devtools/browser/x"]) { write(half); expect(devToolsEndpoint(file), JSON.stringify(half)).toBeUndefined(); }
    write("9222\n/devtools/browser/4f2a-91");
    expect(devToolsEndpoint(file)).toEqual({ port: "9222", path: "/devtools/browser/4f2a-91" });
    write("38211\r\n/devtools/browser/abc\r\n");
    expect(devToolsEndpoint(file)).toEqual({ port: "38211", path: "/devtools/browser/abc" });
  });
});

describe("a page that fails once because the network changed under the browser", () => {
  const waits: number[] = [];
  const wait = async (ms: number): Promise<void> => { waits.push(ms); };
  const failing = (...errors: (string | undefined)[]) => { let n = 0; return { go: async () => errors[Math.min(n++, errors.length - 1)], calls: () => n }; };

  test("the page is asked for once more after a short pause, and the second answer is the answer", async () => {
    waits.length = 0;
    const a = failing("net::ERR_NETWORK_CHANGED", undefined);
    expect(await openWithRetry(a.go, wait)).toBeUndefined();
    expect(a.calls()).toBe(2);
    expect(waits).toEqual([300]);
    waits.length = 0;
    const b = failing("net::ERR_INTERNET_DISCONNECTED", undefined);
    expect(await openWithRetry(b.go, wait)).toBeUndefined();
    expect(waits).toEqual([1_500]);
  });

  test("only once: a second failure is reported as it is, and so is every other error, with no pause", async () => {
    waits.length = 0;
    const twice = failing("net::ERR_NETWORK_CHANGED");
    expect(await openWithRetry(twice.go, wait)).toBe("net::ERR_NETWORK_CHANGED");
    expect(twice.calls()).toBe(2);
    for (const error of ["net::ERR_NAME_NOT_RESOLVED", "net::ERR_CONNECTION_REFUSED", "net::ERR_ABORTED"]) {
      const once = failing(error, undefined);
      expect(await openWithRetry(once.go, wait)).toBe(error);
      expect(once.calls()).toBe(1);
    }
    const fine = failing(undefined);
    expect(await openWithRetry(fine.go, wait)).toBeUndefined();
    expect(fine.calls()).toBe(1);
    expect(waits).toEqual([300]);
  });

  test("with the real clock the pause is the short one and the retry costs under two seconds", async () => {
    const a = failing("net::ERR_NETWORK_CHANGED", undefined);
    const t0 = Date.now();
    await openWithRetry(a.go);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(290);
    expect(Date.now() - t0).toBeLessThan(2_000);
  });
});
