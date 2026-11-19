import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browser, closeBrowser, findChrome } from "../src/index.ts";

const chrome = findChrome();
const site = Bun.serve({
  port: 0,
  fetch(req) {
    const u = new URL(req.url);
    const page = (body: string, title = "Shop") => new Response(`<!doctype html><title>${title}</title><body>${body}</body>`, { headers: { "content-type": "text/html" } });
    if (u.pathname === "/about") return page("<h1>About us</h1><p>We sell lamps.</p><a href='/'>Home</a>", "About");
    if (u.pathname === "/search") return page(`<h1>Results for ${u.searchParams.get("q")} in ${u.searchParams.get("color")}</h1>`, "Results");
    if (u.pathname === "/private") return page("<a href='http://10.1.2.3/secret'>Intranet</a><a href='/about'>About</a>");
    if (u.pathname === "/redirect") return new Response(null, { status: 302, headers: { location: "http://10.1.2.3/inside" } });
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
  test("local and private addresses are refused unless the host allows them: opening, following a link, and being sent there", async () => {
    expect(await run({ action: "open", url: "http://localhost:1/" }, false)).toContain("not allowed");
    expect(await run({ action: "open", url: "file:///etc/passwd" })).toContain("only http(s)");
    expect(await run({ action: "open", url: "ftp://x" })).toContain("only http(s)");
    await run({ action: "open", url: `${home}private` });
    const refs = /\[(\d+)\] link "Intranet"/.exec(await run({ action: "read" }));
    expect(await run({ action: "click", ref: Number(refs![1]) }, false)).toContain("not allowed");
    expect(await run({ action: "open", url: `${home}redirect` }, true)).toBeString();
  }, 60_000);
  test("close ends the browser, and the next use starts a fresh one", async () => {
    expect(await run({ action: "close" })).toContain("closed");
    expect(await run({ action: "open", url: `${home}about` })).toContain("About us");
  }, 45_000);
});

describe.skipIf(!chrome || process.platform === "win32")("a browser that stops while starting", () => {
  const dir = mkdtempSync(join(tmpdir(), "navvied-fakechrome-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
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

  test("one that stopped once is started again, and the second start is the one used", async () => {
    const marker = join(dir, `started-${Math.random().toString(36).slice(2)}`);
    const out = await withBrowser(`if [ ! -e "${marker}" ]; then : > "${marker}"; echo "crashed" >&2; exit 139; fi\nexec "${chrome}" "$@"`, () => run({ action: "open", url: home }));
    expect(out).toContain("Welcome to the shop");
  }, 45_000);
});
