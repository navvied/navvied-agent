import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browser, closeBrowser, findChrome } from "../src/index.ts";
import { devToolsEndpoint, openWithRetry } from "../src/tools/browser.ts";
import { web } from "../src/tools/web-guard.ts";
import { stopAllJobs } from "../src/index.ts";
import { HOOK_MS, hook, removeTree } from "../../protocol/test/support/cleanup.ts";

const chrome = findChrome();
/** A port that nothing listens on (a port that was just let go), so a connection to it is refused at once. */
const deadPort = ((): number => { const probe = Bun.serve({ port: 0, fetch: () => new Response("") }); const port = probe.port!; probe.stop(true); return port; })();
const site = Bun.serve({
  port: 0,
  fetch(req) {
    const u = new URL(req.url);
    const page = (body: string, title = "Shop") => new Response(`<!doctype html><title>${title}</title><body>${body}</body>`, { headers: { "content-type": "text/html" } });
    if (u.pathname === "/about") return page("<h1>About us</h1><p>We sell lamps.</p><a href='/'>Home</a>", "About");
    if (u.pathname === "/search") return page(`<h1>Results for ${u.searchParams.get("q")} in ${u.searchParams.get("color")}</h1>`, "Results");
    if (u.pathname === "/private") return page("<a href='http://10.1.2.3/secret'>Intranet</a><a href='/about'>About</a>");
    if (u.pathname === "/redirect") return new Response(null, { status: 302, headers: { location: `http://127.0.0.1:${deadPort}/inside` } });
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
  test("it is offered only when the work is about the web, and only where a browser is", () => {
    const offered = (userText: string) => browser.offeredWhen!({ small: false, userText, jobs: 0 });
    expect(offered("fix the failing test")).toBe(false);
    if (chrome) { expect(offered("open https://example.com and tell me the price")).toBe(true); expect(offered("log in to the site")).toBe(true); }
  });
});

describe.skipIf(!chrome)("using the browser", () => {
  test("opening a page gives its text and every link and control, numbered", async () => {
    const out = await run({ action: "open", url: home });
    expect(out).toContain("Page: Shop");
    expect(out).toContain("Welcome to the shop");
    expect(out).toMatch(/\[1\] link "About" -> \/about/);
    expect(out).toMatch(/field "Search lamps"/);
    expect(out).toMatch(/choice .*options: Red \| Blue/);
    expect(out).toMatch(/button "Go"/);
  }, 45_000);
  test("clicking a link goes there, back comes back, and a missing control says so", async () => {
    await run({ action: "open", url: home });
    const about = await run({ action: "click", ref: 1 });
    expect(about).toContain("About us");
    expect(about).toContain("We sell lamps.");
    expect(await run({ action: "back" })).toContain("Welcome to the shop");
    expect(await run({ action: "click", ref: 99 })).toContain("no control 99");
    expect(await run({ action: "back" })).toBeString();
  }, 45_000);
  test("typing fills a field, choosing picks an option, and submitting sends the form", async () => {
    const shown = await run({ action: "open", url: home });
    const field = /\[(\d+)\] field/.exec(shown)![1]!, choice = /\[(\d+)\] choice/.exec(shown)![1]!;
    expect(await run({ action: "choose", ref: Number(choice), text: "Blue" })).toContain("(now: blue)");
    expect(await run({ action: "choose", ref: Number(choice), text: "Green" })).toContain('no choice "Green"');
    const results = await run({ action: "type", ref: Number(field), text: "desk lamp", submit: true });
    expect(results).toContain("Results for desk lamp in blue");
  }, 45_000);
  test("scrolling moves down the page, and a page can be read again", async () => {
    await run({ action: "open", url: home });
    const down = await run({ action: "scroll", direction: "down" });
    expect(down).toContain("The very end");
    expect(await run({ action: "read" })).toContain("Welcome to the shop");
  }, 45_000);
  test("local and private addresses are refused unless the host allows them: opening one, and following a link to one", async () => {
    expect(await run({ action: "open", url: "http://localhost:1/" }, false)).toContain("not allowed");
    expect(await run({ action: "open", url: "file:///etc/passwd" })).toContain("only http(s)");
    expect(await run({ action: "open", url: "ftp://x" })).toContain("only http(s)");
    await run({ action: "open", url: `${home}private` });
    const refs = /\[(\d+)\] link "Intranet"/.exec(await run({ action: "read" }));
    expect(await run({ action: "click", ref: Number(refs![1]) }, false)).toContain("not allowed");
    // A page that sends the browser somewhere nobody listens: with the host allowing it, the browser follows and the person is told at once
    // (an address that does not answer at all would be waited on for as long as the browser waits for any page).
    expect(await run({ action: "open", url: `${home}redirect` }, true)).toContain("ERR_CONNECTION_REFUSED");
  }, 20_000);
  test("close ends the browser, and the next use starts a fresh one", async () => {
    expect(await run({ action: "close" })).toContain("closed");
    expect(await run({ action: "open", url: `${home}about` })).toContain("About us");
  }, 45_000);
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

describe.skipIf(!chrome)("a public page cannot send the browser to a private address", () => {
  // Every name below is mapped to this computer by the browser itself (by a flag, so the same on every system), and the lookup the guard makes is stood in for: `public.test` has a
  // public address, `unlisted.test` cannot be looked up at all. So what reaches the server is exactly what the guard let through.
  const hits: string[] = [];
  let port = 0;
  const server = Bun.serve({
    port: 0,
    fetch(req): Response {
      const u = new URL(req.url);
      hits.push(`${u.hostname}${u.pathname}`);
      const page = (body: string) => new Response(`<!doctype html><title>Page</title><body>${body}</body>`, { headers: { "content-type": "text/html" } });
      const inside = `http://127.0.0.1:${port}`;
      if (u.pathname === "/redirect") return new Response(null, { status: 302, headers: { location: `${inside}/secret-redirect` } });
      if (u.pathname === "/jump") return page(`<p>Jumping</p><script>location.href = "${inside}/secret-navigation"</script>`);
      if (u.pathname === "/subresources") return page(`<p>Pictures</p><img src="${inside}/secret-image"><script>fetch("${inside}/secret-fetch").catch(() => {})</script><img src="http://169.254.169.254/latest/meta-data/">`);
      if (u.pathname === "/unlisted") return page(`<p>Unlisted</p><img src="http://unlisted.test:${port}/secret-unlisted">`);
      if (u.pathname === "/fine") return page(`<p>All public</p><img src="http://public.test:${port}/public-image">`);
      return new Response("", { status: 204 });
    },
  });
  port = server.port!;
  const site = (path: string): string => `http://public.test:${port}${path}`;
  const was = { args: process.env.NAVVIED_BROWSER_ARGS, addresses: web.addresses };
  const seen = (path: string): boolean => hits.some((h) => h.endsWith(path));

  beforeAll(() => {
    closeBrowser();
    process.env.NAVVIED_BROWSER_ARGS = JSON.stringify(["--host-resolver-rules=MAP public.test 127.0.0.1, MAP unlisted.test 127.0.0.1"]);
    web.addresses = async (host: string) => { if (host === "public.test") return ["93.184.216.34"]; throw new Error("cannot be looked up"); };
  });
  afterAll(hook("browser guard removes what it made", async () => {
    closeBrowser();
    server.stop(true);
    web.addresses = was.addresses;
    if (was.args === undefined) delete process.env.NAVVIED_BROWSER_ARGS; else process.env.NAVVIED_BROWSER_ARGS = was.args;
    await stopAllJobs();
  }), HOOK_MS);

  test("a redirect to a private address is refused, and the person is told why", async () => {
    const out = await run({ action: "open", url: site("/redirect") }, false);
    expect(out).toContain("not allowed");
    expect(seen("/secret-redirect")).toBe(false);
  }, 30_000);

  test("a page that navigates itself there, and one that loads something from there (a picture, a script's fetch, the cloud metadata address), reach nothing", async () => {
    await run({ action: "open", url: site("/jump") }, false);
    await run({ action: "open", url: site("/subresources") }, false);
    expect(seen("/secret-navigation")).toBe(false);
    expect(seen("/secret-image")).toBe(false);
    expect(seen("/secret-fetch")).toBe(false);
  }, 30_000);

  test("a name that cannot be looked up is not let through either", async () => {
    await run({ action: "open", url: site("/unlisted") }, false);
    expect(seen("/secret-unlisted")).toBe(false);
  }, 30_000);

  test("what is public still loads, so the refusals are the guard's and not a broken browser", async () => {
    expect(await run({ action: "open", url: site("/fine") }, false)).toContain("All public");
    expect(seen("/public-image")).toBe(true);
  }, 30_000);

  test("a host that allows private addresses is still allowed to: the same page reaches them", async () => {
    await run({ action: "open", url: site("/subresources") }, true);
    expect(seen("/secret-image")).toBe(true);
    expect(seen("/secret-fetch")).toBe(true);
  }, 30_000);
});
