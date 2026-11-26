import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { QuestionItem } from "@navvied/protocol";
import { browser, closeBrowser, findChrome } from "../src/tools/browser.ts";
import { startGuardProxy } from "../src/tools/browser/guard-proxy.ts";
import { launch } from "../src/tools/browser/launch.ts";
import { jpegSize } from "../src/tools/browser/page.ts";
import { web } from "../src/tools/web-guard.ts";
import { stopAllJobs } from "../src/index.ts";
import { until } from "./helpers.ts";
import { HOOK_MS, hook } from "../../protocol/test/support/cleanup.ts";
import type { Part } from "../src/types.ts";

/** The tool against a real browser: these skip where none is installed (the stand-in tests in browser-fake.test.ts cover the same logic everywhere). */
const chrome = findChrome();
const PASSWORD = "Zx9!kQ7mPw";
const posted: string[] = [];
const deadPort = (): number => { const probe = Bun.serve({ port: 0, fetch: () => new Response("") }); const port = probe.port!; probe.stop(true); return port; };
const sockets: string[] = [];
const hits: string[] = [];

const site: import("bun").Server<{ id: number }> = Bun.serve<{ id: number }>({
  port: 0,
  async fetch(req, server): Promise<Response | undefined> {
    const u = new URL(req.url);
    hits.push(`${u.hostname}${u.pathname}`);
    const inside = `http://127.0.0.1:${site.port}`;
    const page = (body: string, title = "Shop") => new Response(`<!doctype html><title>${title}</title><body>${body}</body>`, { headers: { "content-type": "text/html" } });
    if (u.pathname === "/socket" && req.headers.get("upgrade") === "websocket") { sockets.push(u.host); return server.upgrade(req, { data: { id: 1 } }) ? undefined : new Response("no"); }
    if (u.pathname === "/redirect-in") return new Response(null, { status: 302, headers: { location: `${inside}/secret-redirect` } });
    if (u.pathname === "/jump-in") return page(`<p>Jumping</p><script>location.href = "${inside}/secret-navigation"</script>`);
    if (u.pathname === "/subresources") return page(`<p>Pictures</p><img src="${inside}/secret-image"><script>fetch("${inside}/secret-fetch").catch(() => {})</script><img src="http://169.254.169.254/latest/meta-data/">`);
    if (u.pathname === "/unlisted") return page(`<p>Unlisted</p><img src="http://unlisted.test:${site.port}/secret-unlisted">`);
    if (u.pathname === "/fine") return page(`<p>All public</p><img src="http://public.test:${site.port}/public-image">`);
    if (u.pathname === "/private-ok") return page(`<p>Pictures</p><img src="${inside}/secret-image"><script>fetch("${inside}/secret-fetch").catch(() => {})</script>`);
    if (u.pathname === "/missing") return new Response("gone", { status: 404 });
    if (u.pathname === "/about") return page("<h1>About us</h1><p>We sell lamps.</p><a href='/'>Home</a>", "About");
    if (u.pathname === "/search") return page(`<h1>Results for ${u.searchParams.get("q")} in ${u.searchParams.get("color")}</h1>`, "Results");
    if (u.pathname === "/private") return page("<a href='http://10.1.2.3/secret'>Intranet</a><a href='/about'>About</a>");
    if (u.pathname === "/redirect") return new Response(null, { status: 302, headers: { location: `http://127.0.0.1:${deadPort()}/inside` } });
    if (u.pathname === "/jump") return page("<button onclick=\"setTimeout(() => { location.href = '/about'; }, 400)\">Leave</button><a href='/'>Home</a>", "Jump");
    if (u.pathname === "/dialogs") return page(`<button onclick="alert('Saved!')">Alert</button><button onclick="document.title = confirm('Sure?') ? 'yes' : 'no'">Confirm</button><button onclick="document.title = 'hi ' + prompt('Name?', 'Ann')">Prompt</button><p id="t">dialogs</p>`, "Dialogs");
    if (u.pathname === "/inner") return page(`<button onclick="document.getElementById('r').textContent = 'inner clicked'">Inner button</button><input aria-label="Inner field" oninput="document.getElementById('r').textContent = 'typed ' + this.value"><p id="r">waiting</p>`, "Inner");
    if (u.pathname === "/frames") return page(`<h1>Frames</h1><button onclick="document.getElementById('o').textContent = 'outer clicked'">Outer button</button><p id="o">outer waiting</p><iframe title="Same site" style="position:absolute;left:100px;top:260px;width:400px;height:150px" src="${inside}/inner"></iframe><iframe title="Other site" style="position:absolute;left:100px;top:460px;width:400px;height:150px" src="http://localhost:${site.port}/inner"></iframe>`, "Frames");
    if (u.pathname === "/hover") return page(`<div role="button" aria-label="Menu" tabindex="0" style="width:120px;height:40px;background:#ccc" onmouseover="document.getElementById('t').textContent = 'menu open'">Menu</div><p id="t">closed</p>`, "Hover");
    if (u.pathname === "/dnd") return page(`<div role="button" aria-label="Card" draggable="true" style="width:80px;height:40px;background:#9cf" ondragstart="event.dataTransfer.setData('text/plain', 'card-7')">Card</div><div role="button" aria-label="Zone" style="width:160px;height:80px;background:#fc9;margin-top:20px" ondragover="event.preventDefault()" ondrop="event.preventDefault(); document.getElementById('t').textContent = 'dropped ' + event.dataTransfer.getData('text/plain')">Zone</div><p id="t">nothing dropped</p>`, "Drag");
    if (u.pathname === "/knob") return page(`<div id="k" role="button" aria-label="Knob" style="position:absolute;left:20px;top:100px;width:40px;height:40px;background:#c33"></div><p id="t" style="position:absolute;top:200px">idle</p><script>let sx = null; k.onmousedown = (e) => { sx = e.clientX; }; addEventListener("mouseup", (e) => { if (sx !== null) { t.textContent = "knob moved " + Math.round(e.clientX - sx); sx = null; } });</script>`, "Knob");
    if (u.pathname === "/coords") return page(`<button style="position:absolute;left:200px;top:300px;width:100px;height:50px" onclick="document.getElementById('t').textContent = 'coordinate click'">Target</button><p id="t">not clicked</p>`, "Coords");
    if (u.pathname === "/form") return page(`<label>Name <input id="n"></label><label>Color <select id="c"><option value="r">Red</option><option value="b">Blue</option></select></label><label><input id="t" type="checkbox"> Terms</label><label>Note <textarea id="m"></textarea></label>`, "Form");
    if (u.pathname === "/popup") return page("<a href='/about' target='_blank'>Open about</a>", "Popup");
    if (u.pathname === "/file.txt") return new Response("file body", { headers: { "content-type": "text/plain", "content-disposition": 'attachment; filename="notes.txt"' } });
    if (u.pathname === "/files") return page("<a href='/file.txt'>Get notes</a>", "Files");
    if (u.pathname === "/upload") return page(`<input type="file" id="f" aria-label="Pick a file" onchange="document.getElementById('n').textContent = 'chosen ' + this.files[0].name"><p id="n">nothing</p>`, "Upload");
    if (u.pathname === "/logs") return page(`<script>console.error("boom"); fetch("/missing").catch(() => {})</script><p>logs</p>`, "Logs");
    if (u.pathname === "/late") return page(`<p>early</p><script>setTimeout(() => { document.body.insertAdjacentHTML("beforeend", "<p>Order confirmed</p>"); }, 600)</script>`, "Late");
    if (u.pathname === "/ws") return page(`<p id="r">pending</p><script>
      const report = (m) => { document.title = (document.title === "ws" ? "" : document.title) + m; document.getElementById("r").textContent = document.title; };
      const open = (url, tag) => { try { const s = new WebSocket(url); s.onopen = () => { report(tag + " open;"); s.close(); }; s.onerror = () => report(tag + " failed;"); } catch { report(tag + " failed;"); } };
      open("ws://" + location.hostname + ":${site.port}/socket", "same"); open("ws://127.0.0.1:${site.port}/socket", "literal");
    </script>`, "ws");
    if (u.pathname === "/login" && req.method === "POST") { const body = await req.text(); posted.push(`${u.host} ${body}`); return new Response(null, { status: 303, headers: { location: "/account", "set-cookie": "s=1; Path=/" } }); }
    if (u.pathname === "/login") return page(`<form method="post" action="/login"><label>Email <input name="email" type="text"></label><label>Password <input name="password" type="password"></label><button type="submit">Sign in</button></form>`, "Sign in");
    if (u.pathname === "/account") return page(req.headers.get("cookie")?.includes("s=1") ? "<h1>Welcome back, ann</h1>" : "<h1>Please sign in</h1>", "Account");
    if (u.pathname === "/gate-login") return new Response(null, { status: 302, headers: { location: `http://localhost:${site.port}/login` } });
    if (u.pathname === "/gate") return page(`<p>Prove you are human</p><div class="g-recaptcha"></div>`, "Gate");
    return page(`<h1>Welcome to the shop</h1><p>${"Lamps and more. ".repeat(10)}</p><a href="/about">About</a><a href="/private">Links</a>
      <form action="/search"><input name="q" placeholder="Search lamps" aria-label="Search lamps"><select name="color" aria-label="Color"><option value="red">Red</option><option value="blue">Blue</option></select><button type="submit">Go</button></form>
      <div style="height:3000px"></div><p id="bottom">The very end</p>`);
  },
  websocket: { open() {}, message() {} },
});
const dir = mkdtempSync(join(tmpdir(), "navvied-chrome-test-"));
afterAll(hook("browser tests remove what they made", async () => { closeBrowser(); site.stop(true); await stopAllJobs(); }), HOOK_MS);

const shown: Part[] = [];
const asked: QuestionItem[][] = [];
interface Opts { priv?: boolean; vision?: boolean; creds?: { secrets: string[]; origins: string[] }; ask?: boolean }
const run = (a: Record<string, unknown>, o: Opts = {}): Promise<string> => browser.run(a, {
  cwd: dir, signal: new AbortController().signal, emit() {}, allowPrivateNetwork: o.priv ?? true, show: (p: Part) => { shown.push(p); },
  ...(o.vision !== undefined ? { vision: o.vision } : {}), ...(o.creds ? { credentials: () => o.creds! } : {}),
  ...(o.ask ? { ask: async (q: QuestionItem[]) => { asked.push(q); return "stop"; } } : {}),
} as never);
const home = `http://127.0.0.1:${site.port}/`;
const at = (path: string): string => `${home}${path.replace(/^\//, "")}`;
const refOf = (out: string, pattern: RegExp): number => Number(new RegExp(`\\[(\\d+)\\] ${pattern.source}`).exec(out)![1]);

describe.skipIf(!chrome)("using the browser", () => {
  test("opening a page gives what is on it, and a number on every link and control", async () => {
    const out = await run({ action: "open", url: home });
    expect(out).toContain("Page: Shop");
    expect(out).toContain("heading 1: Welcome to the shop");
    expect(out).toMatch(/\[\d+\] link "About" -> http:\/\/127.0.0.1:\d+\/about/);
    expect(out).toMatch(/textbox "Search lamps"/);
    expect(out).toMatch(/combobox "Color" value="Red" options: Red \| Blue/);
    expect(out).toMatch(/button "Go"/);
  }, 45_000);

  test("clicking a link goes there, back comes back, and a number that is not there says so", async () => {
    const first = await run({ action: "open", url: home });
    const about = await run({ action: "click", ref: refOf(first, /link "About"/) });
    expect(about).toContain("About us");
    expect(about).toContain("We sell lamps.");
    expect(await run({ action: "back" })).toContain("Welcome to the shop");
    expect(await run({ action: "click", ref: 99 })).toContain("there is no control 99");
  }, 45_000);

  test("typing fills a field, choosing picks an option, and Enter sends the form", async () => {
    const shown = await run({ action: "open", url: home });
    const field = refOf(shown, /textbox "Search lamps"/), choice = refOf(shown, /combobox "Color"/);
    expect(await run({ action: "choose", ref: choice, text: "Blue" })).toContain('value="Blue"');
    expect(await run({ action: "choose", ref: choice, text: "Green" })).toContain('has no choice "Green"');
    expect(await run({ action: "type", ref: field, text: "desk lamp", submit: true })).toContain("Results for desk lamp in blue");
  }, 45_000);

  test("scrolling moves down the page, and the page can be read again", async () => {
    await run({ action: "open", url: home });
    expect(await run({ action: "scroll", direction: "down" })).toMatch(/Scrolled \d+ of \d+ px/);
    expect(await run({ action: "read" })).toContain("The very end");
  }, 45_000);

  test("numbers expire when the page goes elsewhere on its own, and the answer gives the new ones", async () => {
    const jump = await run({ action: "open", url: at("jump") });
    await run({ action: "click", ref: refOf(jump, /button "Leave"/) });
    let tabs = "";
    for (let i = 0; i < 50 && !tabs.includes("/about"); i++) { await new Promise((r) => setTimeout(r, 100)); tabs = await run({ action: "tabs" }); }
    const late = await run({ action: "click", ref: 1 });
    expect(late).toContain("Error: the page went to");
    expect(late).toContain("Nothing was done.");
    expect(late).toContain("About us");
    expect(late).toMatch(/\[1\] link "Home"/);
  }, 45_000);

  test("an alert, a confirm and a prompt are seen and answered, and the page goes on", async () => {
    const page = await run({ action: "open", url: at("dialogs") });
    const t0 = Date.now();
    const alerted = await run({ action: "click", ref: refOf(page, /button "Alert"/) });
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(alerted).toContain("A alert dialog is open");
    expect(alerted).toContain("Saved!");
    expect(await run({ action: "dialog" })).toContain("dialog was accepted");
    const again = await run({ action: "read" });
    await run({ action: "click", ref: refOf(again, /button "Confirm"/) });
    expect(await run({ action: "dialog", accept: false })).toContain("Page: no");
    await run({ action: "click", ref: refOf(again, /button "Prompt"/) });
    const answered = await run({ action: "dialog", text: "Bo" });
    expect(answered).toContain("Page: hi Bo");
  }, 60_000);

  test("a link that opens a new window is followed into it, and the first tab is still there", async () => {
    const page = await run({ action: "open", url: at("popup") });
    const out = await run({ action: "click", ref: refOf(page, /link "Open about"/) });
    expect(out).toContain("A new tab opened (tab 2)");
    expect(out).toContain("About us");
    const list = await run({ action: "tabs" });
    expect(list).toMatch(/1 {2}Popup/);
    expect(list).toMatch(/2\* About/);
    expect(await run({ action: "switch", tab: 1 })).toContain("Open about");
    expect(await run({ action: "close", tab: 2 })).toContain("Tab 2 is closed");
  }, 60_000);

  test("a download lands in the project's downloads folder, and a file can be put into a field", async () => {
    const files = await run({ action: "open", url: at("files") });
    const got = await run({ action: "click", ref: refOf(files, /link "Get notes"/) });
    expect(got).toContain("Downloaded downloads/notes.txt (9 bytes)");
    expect(readFileSync(join(dir, "downloads", "notes.txt"), "utf8")).toBe("file body");
    const up = await run({ action: "open", url: at("upload") });
    writeFileSync(join(dir, "cv.txt"), "cv");
    const field = refOf(up, /button "Pick a file"|\S+ "Pick a file"/);
    expect(await run({ action: "upload", ref: field, path: "cv.txt" })).toContain("Uploaded cv.txt (2 bytes)");
    expect(await run({ action: "read" })).toContain("chosen cv.txt");
  }, 60_000);

  test("a picture goes to a model that can see, as a JPEG; any other gets the page in words", async () => {
    await run({ action: "open", url: home });
    shown.length = 0;
    await run({ action: "screenshot" }, { vision: true });
    expect(shown).toHaveLength(1);
    const image = shown[0] as { mime: string; data: string };
    expect(image.mime).toBe("image/jpeg");
    expect(Buffer.from(image.data, "base64").subarray(0, 3).toString("hex")).toBe("ffd8ff");
    expect(Buffer.from(image.data, "base64").length).toBeLessThan(256 * 1024);
    shown.length = 0;
    const words = await run({ action: "screenshot" }, { vision: false });
    expect(words).toContain("cannot see pictures");
    expect(words).toMatch(/\d+ links, \d+ buttons/);
    expect(shown).toHaveLength(0);
  }, 45_000);

  test("what the page wrote to the console and what failed to load is told on request, and waiting ends when the text is there", async () => {
    await run({ action: "open", url: at("logs") });
    const out = await run({ action: "console" });
    expect(out).toContain("[error] boom");
    expect(out).toMatch(/404 http:\/\/127.0.0.1:\d+\/missing/);
    await run({ action: "open", url: at("late") });
    expect(await run({ action: "wait", text: "order confirmed", seconds: 10 })).toContain("Order confirmed");
    expect(await run({ action: "wait", selector: "#nothing", seconds: 1 })).toContain("did not happen");
  }, 60_000);

  test("a page that asks for a check for people is put to the person and never tried", async () => {
    asked.length = 0;
    const out = await run({ action: "open", url: at("gate") }, { ask: true });
    expect(asked[0]![0]!.question).toContain("only a person can pass");
    expect(out).toContain("Do not try to solve the check yourself");
  }, 45_000);

  test("local and private addresses are refused unless the host allows them, for an address and for a link", async () => {
    expect(await run({ action: "open", url: "http://localhost:1/" }, { priv: false })).toContain("not allowed");
    expect(await run({ action: "open", url: "file:///etc/passwd" })).toContain("only http(s)");
    expect(await run({ action: "open", url: "ftp://x" })).toContain("only http(s)");
    const links = await run({ action: "open", url: at("private") });
    expect(await run({ action: "click", ref: refOf(links, /link "Intranet"/) }, { priv: false })).toContain("not allowed");
    // A page that sends the browser somewhere nobody listens: the connection is made by the guard, which says so.
    expect(await run({ action: "open", url: at("redirect") })).toContain("could not be reached");
  }, 45_000);

  test("close ends the browser, and the next use starts a fresh one", async () => {
    expect(await run({ action: "close" })).toContain("closed");
    expect(await run({ action: "open", url: at("about") })).toContain("About us");
  }, 45_000);
});

describe.skipIf(!chrome)("signing in with what the person gave", () => {
  const creds = { secrets: [PASSWORD], origins: [`http://127.0.0.1:${site.port}`] };
  const login = async (path: string): Promise<string> => {
    const form = await run({ action: "open", url: at(path) }, { creds });
    if (!/Password/.test(form)) return form;
    await run({ action: "type", ref: refOf(form, /textbox "Email"/), text: "ann@example.com" }, { creds });
    return run({ action: "type", ref: refOf(form, /textbox "Password"/), text: PASSWORD, submit: true }, { creds });
  };

  test("the site the person named takes the login, and nothing the model reads holds the password", async () => {
    posted.length = 0;
    const out = await login("login");
    expect(out).toContain("Welcome back, ann");
    expect(posted).toHaveLength(1);
    expect(new URLSearchParams(posted[0]!.split(" ")[1]).get("password")).toBe(PASSWORD);
    expect(out).not.toContain(PASSWORD);
    expect(await run({ action: "console" }, { creds })).not.toContain(PASSWORD);
  }, 60_000);

  test("a page that sent the browser to another site gets no password", async () => {
    posted.length = 0;
    const out = await login("gate-login");
    expect(out).toContain("Not typed: this page is http://localhost:");
    expect(out).toContain(`http://127.0.0.1:${site.port}`);
    expect(out).not.toContain(PASSWORD);
    expect(posted).toHaveLength(0);
  }, 60_000);
});

describe.skipIf(!chrome)("every connection the browser makes is looked at, WebSockets included", () => {
  // `public.test` has a public address as far as the guard knows, and is dialled at this computer; nothing else is let through.
  const was = { addresses: web.addresses, dial: web.dial };
  beforeAll(() => {
    closeBrowser();
    web.addresses = async (host: string) => { if (host === "public.test") return ["93.184.216.34"]; throw new Error("cannot be looked up"); };
    web.dial = (address, port, socket, data) => was.dial(address === "93.184.216.34" || address === "public.test" ? "127.0.0.1" : address, port, socket, data);
  });
  afterAll(() => { closeBrowser(); web.addresses = was.addresses; web.dial = was.dial; });

  test("a page may open a WebSocket to a public name, and not to a local address", async () => {
    sockets.length = 0;
    const out = await run({ action: "open", url: `http://public.test:${site.port}/ws` }, { priv: false });
    let text = out;
    for (let i = 0; i < 50 && !(/same (open|failed)/.test(text) && /literal (open|failed)/.test(text)); i++) { await new Promise((r) => setTimeout(r, 100)); text = await run({ action: "read" }, { priv: false }); }
    expect(text).toContain("same open");
    expect(text).toContain("literal failed");
    expect(sockets.some((h) => h.startsWith("public.test"))).toBe(true);
    expect(sockets.some((h) => h.startsWith("127.0.0.1"))).toBe(false);
  }, 60_000);

  test("what is public still loads, and a name that cannot be looked up does not", async () => {
    expect(await run({ action: "open", url: `http://public.test:${site.port}/about` }, { priv: false })).toContain("About us");
    const out = await run({ action: "open", url: `http://unlisted.test:${site.port}/about` }, { priv: false });
    expect(out).toContain("Error");
    expect(out).not.toContain("About us");
  }, 60_000);

  const seen = (path: string): boolean => hits.some((h) => h.endsWith(path));
  const publicSite = (path: string): string => `http://public.test:${site.port}${path}`;

  test("a redirect to a private address, a page that navigates itself there, and pictures and scripts that load from there reach nothing", async () => {
    expect(await run({ action: "open", url: publicSite("/redirect-in") }, { priv: false })).toContain("not allowed");
    await run({ action: "open", url: publicSite("/jump-in") }, { priv: false });
    await run({ action: "open", url: publicSite("/subresources") }, { priv: false });
    await run({ action: "open", url: publicSite("/unlisted") }, { priv: false });
    for (const path of ["/secret-redirect", "/secret-navigation", "/secret-image", "/secret-fetch", "/secret-unlisted"]) expect(seen(path), path).toBe(false);
  }, 90_000);

  test("what is public still loads, so the refusals are the guard's and not a broken browser", async () => {
    expect(await run({ action: "open", url: publicSite("/fine") }, { priv: false })).toContain("All public");
    await until(() => seen("/public-image"));
  }, 30_000);

  test("a host that allows private addresses is still allowed to: the same page reaches them", async () => {
    await run({ action: "open", url: publicSite("/private-ok") }, { priv: true });
    await until(() => seen("/secret-image") && seen("/secret-fetch"));
  }, 30_000);
});

/** The processes of every browser whose profile is under `under` (stop() relies on this mark reaching all a browser starts). */
const processesOf = (under: string): { pid: number; group: number }[] => readdirSync("/proc").flatMap((name) => {
  try {
    if (!readFileSync(`/proc/${name}/environ`, "utf8").includes(`NAVVIED_BROWSER_PROFILE=${under}/`)) return [];
    const stat = readFileSync(`/proc/${name}/stat`, "utf8"), f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return "ZXx".includes(f[0]!) ? [] : [{ pid: Number(name), group: Number(f[2]) }];
  } catch { return []; }
});

// What this Chrome still asks for by itself after every switch that turns its background traffic off was tried (the component updater, the
// list of signed-in accounts, the eligibility of its search-box assistant): none has a switch of its own in this version. A host that is
// not in this list is new traffic, and fails here.
const OWN = ["update.googleapis.com", "accounts.google.com", "www.google.com"];

describe.skipIf(!chrome)("a browser nobody has asked anything of", () => {

  test("asks nothing of the network by itself in the first seconds, apart from the few services of its own that have no switch", async () => {
    const was = { addresses: web.addresses, dial: web.dial };
    const reached: string[] = [];
    web.addresses = async (host: string) => { reached.push(host); throw new Error("cannot be looked up"); };
    web.dial = (address, port, socket, data) => { reached.push(address); return was.dial(address, port, socket, data); };
    const proxy = startGuardProxy(() => false, () => undefined);
    const launched = await launch(chrome!, proxy.port);
    try { await new Promise((r) => setTimeout(r, 6_000)); } finally { launched.stop(); proxy.close(); web.addresses = was.addresses; web.dial = was.dial; }
    expect([...new Set(reached)].filter((h) => !OWN.includes(h))).toEqual([]);
  }, 60_000);
});

describe.skipIf(!chrome)("a session in which the person's page has a form", () => {
  // The form is what makes this browser ask its vendor about the fields; the wait is longer than the moment that question is asked at.
  test("connects to the page's own address and nothing else but the few known, and its crash handler writes only inside the browser's own folder", async () => {
    closeBrowser();
    const under = realpathSync(mkdtempSync(join(tmpdir(), "navvied-session-test-")));
    const was = { tmp: process.env.TMPDIR, addresses: web.addresses, dial: web.dial };
    const reached = new Set<string>(), databases: string[] = [];
    // Nothing leaves this computer: a name is not looked up and only the test's own site is dialled.
    web.addresses = async (host: string) => { reached.add(host); throw new Error("cannot be looked up"); };
    web.dial = (address, port, socket, data) => { reached.add(address); return address === "127.0.0.1" ? was.dial(address, port, socket, data) : Promise.reject(new Error("not let out")); };
    try {
      process.env.TMPDIR = under;
      const form = await run({ action: "open", url: at("form") });
      await run({ action: "type", ref: refOf(form, /textbox "Name"/), text: "ann" });
      await run({ action: "click", ref: refOf(form, /checkbox "Terms"/) });
      await new Promise((r) => setTimeout(r, 4_000));
      if (process.platform === "linux") for (const { pid } of processesOf(under)) {
        const cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
        const database = cmd.find((a) => a.startsWith("--database="));
        if (/crashpad_handler$/.test(cmd[0]!) && database) databases.push(database.slice("--database=".length));
      }
      expect(databases.filter((d) => !d.startsWith(`${under}/`))).toEqual([]);
      closeBrowser();
      if (process.platform === "linux") expect(processesOf(under)).toEqual([]);
      expect(databases.filter((d) => existsSync(d))).toEqual([]);
      expect([...reached].filter((h) => h !== "127.0.0.1" && !OWN.includes(h))).toEqual([]);
    } finally {
      closeBrowser();
      if (was.tmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = was.tmp;
      web.addresses = was.addresses; web.dial = was.dial;
      rmSync(under, { recursive: true, force: true });
    }
  }, 60_000);
});

describe.skipIf(!chrome || process.platform !== "linux")("stopping this computer's browser", () => {
  test("leaves none of it running when it returns, its helpers outside its process group included", async () => {
    const under = realpathSync(mkdtempSync(join(tmpdir(), "navvied-stop-test-")));
    const was = process.env.TMPDIR;
    const proxy = startGuardProxy(() => false, () => undefined);
    try {
      process.env.TMPDIR = under;
      const launched = await launch(chrome!, proxy.port);
      const before = processesOf(under);
      launched.stop();
      expect(before.length).toBeGreaterThan(1);
      expect(processesOf(under)).toEqual([]);
    } finally {
      if (was === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = was;
      proxy.close();
      rmSync(under, { recursive: true, force: true });
    }
  }, 60_000);
});

describe.skipIf(!chrome)("reaching more of a page", () => {
  const allRefs = (out: string, pattern: RegExp): number[] => [...out.matchAll(new RegExp(`\\[(\\d+)\\] ${pattern.source}`, "g"))].map((m) => Number(m[1]));

  test("a frame of the same site and a frame of another site are read with the page, and used by their numbers", async () => {
    const out = await run({ action: "open", url: at("frames") });
    expect(out).toContain(`frame "Same site": http://127.0.0.1:${site.port}/inner`);
    expect(out).toContain(`frame "Other site": http://localhost:${site.port}/inner`);
    // The page is quiet once its frames have loaded: a request of a frame of another site that never ended would hold every later step for the whole of the wait.
    const t0 = Date.now();
    await run({ action: "hover", ref: refOf(out, /button "Outer button"/) });
    expect(Date.now() - t0).toBeLessThan(4_000);
    const buttons = allRefs(out, /button "Inner button"/);
    // A frame read without its button was seen once and not again: what names the cause is which frame it was, what it held then, and whether a later reading has it.
    const why = buttons.length === 2 ? "" : `the first reading:\n${out}\n\nthe same page read again:\n${await run({ action: "read" })}\n\n${await run({ action: "console" })}`;
    expect(buttons.length, why).toBe(2);
    const [same, other] = buttons;
    expect(other).toBeGreaterThan(same!);
    const clicked = await run({ action: "click", ref: other! });
    // The text lands under the frame of the other site, and the frame of the same site is as it was.
    expect(clicked.slice(clicked.indexOf("Other site"))).toContain("inner clicked");
    expect(clicked.slice(0, clicked.indexOf("Other site"))).not.toContain("inner clicked");
    const typed = await run({ action: "type", ref: allRefs(clicked, /textbox "Inner field"/)[0]!, text: "hello" });
    expect(typed.slice(0, typed.indexOf("Other site"))).toContain("typed hello");
    const outer = await run({ action: "click", ref: refOf(typed, /button "Outer button"/) });
    expect(outer).toContain("outer clicked");
  }, 60_000);

  test("hover opens what only a pointer over a control opens", async () => {
    const page = await run({ action: "open", url: at("hover") });
    expect(page).toContain("closed");
    expect(await run({ action: "hover", ref: refOf(page, /button "Menu"/) })).toContain("menu open");
  }, 45_000);

  test("a drag and drop of the browser's own kind carries what was dragged to where it was dropped", async () => {
    const page = await run({ action: "open", url: at("dnd") });
    const out = await run({ action: "drag", ref: refOf(page, /button "Card"/), to: refOf(page, /button "Zone"/) });
    expect(out).toContain("dropped card-7");
  }, 45_000);

  test("a drag that only uses the mouse moves a control by a place the model names", async () => {
    const page = await run({ action: "open", url: at("knob") });
    // The knob's middle is at 40, 120.
    expect(await run({ action: "drag", ref: refOf(page, /button "Knob"/), x2: 190, y2: 120 })).toContain("knob moved 150");
  }, 45_000);

  test("a click at a place in the screenshot hits the control that is there, whatever the size of the picture", async () => {
    await run({ action: "open", url: at("coords") });
    shown.length = 0;
    await run({ action: "screenshot" }, { vision: true });
    const size = jpegSize((shown[0] as { data: string }).data)!;
    const window = JSON.parse(/\[[\d,]+\]/.exec(await run({ action: "eval", text: "JSON.stringify([innerWidth, innerHeight])" }))![0]) as number[];
    // The button's middle is at 250, 325 in the window.
    const out = await run({ action: "click", x: Math.round((250 * size.width) / window[0]!), y: Math.round((325 * size.height) / window[1]!) });
    expect(out).toContain("coordinate click");
  }, 45_000);

  test("a whole form is filled in one call: text, a list, a box and a long text", async () => {
    const page = await run({ action: "open", url: at("form") });
    const fields = { [refOf(page, /textbox "Name"/)]: "Ann", [refOf(page, /combobox "Color"/)]: "Blue", [refOf(page, /checkbox "Terms"/)]: "yes", [refOf(page, /textbox "Note"/)]: "two\nlines" };
    const out = await run({ action: "fill", fields });
    expect(out).toContain('checkbox "Terms" (checked)');
    const values = await run({ action: "eval", text: "JSON.stringify([n.value, c.value, t.checked, m.value])" });
    expect(values).toContain('["Ann","b",true,"two\\nlines"]');
  }, 45_000);

  test("a login is filled in one call on the site the person named, and not on another", async () => {
    const creds = { secrets: [PASSWORD], origins: [`http://127.0.0.1:${site.port}`] };
    posted.length = 0;
    const form = await run({ action: "open", url: at("login") }, { creds });
    const fields = { [refOf(form, /textbox "Email"/)]: "ann@example.com", [refOf(form, /textbox "Password"/)]: PASSWORD };
    const filled = await run({ action: "fill", fields }, { creds });
    expect(filled).not.toContain(PASSWORD);
    const out = await run({ action: "click", ref: refOf(filled, /button "Sign in"/) }, { creds });
    expect(out).toContain("Welcome back, ann");
    expect(new URLSearchParams(posted[0]!.split(" ")[1]).get("password")).toBe(PASSWORD);
    const moved = await run({ action: "open", url: at("gate-login") }, { creds });
    const refused = await run({ action: "fill", fields: { [refOf(moved, /textbox "Password"/)]: PASSWORD } }, { creds });
    expect(refused).toContain("Not typed");
    expect(refused).not.toContain(PASSWORD);
    expect(posted).toHaveLength(1);
  }, 90_000);
});
