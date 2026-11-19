import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Options } from "../src/args.ts";
import { startHttpServer, type HttpServer } from "../src/commands/serve-http.ts";
import { WEB_ASSETS } from "../src/web-assets.ts";
import { fakeIO, remove, startMockModel, tempDir } from "./helpers.ts";

let mock: ReturnType<typeof startMockModel>;
let server: HttpServer;
const dirs: string[] = [];
let base = "";

beforeAll(async () => {
  mock = startMockModel();
  const state = tempDir(), work = tempDir();
  dirs.push(state, work);
  const io = fakeIO({ env: { HOME: state, XDG_STATE_HOME: state, NAVVIED_BASE_URL: mock.url, NAVVIED_MODEL: "mock-model", NAVVIED_WINDOW: "100000" } }).io;
  const options: Options = { json: false, yes: false, thinking: false, port: 0, cwd: work };
  const started = await startHttpServer(options, io);
  if (!started.ok) throw new Error(started.error);
  server = started.server;
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(async () => { await server.stop(); mock.stop(); dirs.forEach(remove); });

describe("serve --http without --web serves the built-in front-end", () => {
  test("the page and its script come from inside the program", async () => {
    const page = await fetch(`${base}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(page.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(await page.text()).toContain('<div id="root">');

    const script = await fetch(`${base}/main.js`);
    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toContain("text/javascript");
    expect((await script.text()).length).toBeGreaterThan(10_000);

    const css = await fetch(`${base}/styles.css`);
    expect(css.headers.get("content-type")).toContain("text/css");
    expect((await fetch(`${base}/manifest.webmanifest`)).headers.get("content-type")).toContain("application/manifest+json");
  });

  test("every built-in file is reachable and typed", async () => {
    for (const path of Object.keys(WEB_ASSETS)) {
      const res = await fetch(`${base}${path}`);
      expect(res.status).toBe(200);
      const text = WEB_ASSETS[path] as string;
      // a picture is kept as base64 text in the embedded copy and sent as its bytes
      if (text.startsWith("base64:")) expect(Buffer.from(await res.arrayBuffer()).equals(Buffer.from(text.slice(7), "base64"))).toBe(true);
      else expect(await res.text()).toBe(text);
    }
  });

  test("the app can be installed: PNG icons of the sizes browsers ask for, as real PNG files, listed in the manifest, with the iPhone home-screen icon", async () => {
    const manifest = (await (await fetch(`${base}/manifest.webmanifest`)).json()) as { icons: { src: string; sizes: string; type: string; purpose: string }[] };
    const png = manifest.icons.filter((i) => i.type === "image/png");
    expect(png.some((i) => i.sizes === "192x192" && i.purpose === "any")).toBe(true);
    expect(png.some((i) => i.sizes === "512x512" && i.purpose === "any")).toBe(true);
    expect(png.some((i) => i.sizes === "512x512" && i.purpose === "maskable")).toBe(true);
    for (const src of [...png.map((i) => i.src), "/apple-touch-icon.png"]) {
      const res = await fetch(`${base}${src}`);
      expect(res.headers.get("content-type")).toBe("image/png");
      const bytes = new Uint8Array(await res.arrayBuffer());
      expect([...bytes.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    }
    expect(await (await fetch(`${base}/`)).text()).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png">');
    const sw = await (await fetch(`${base}/sw.js`)).text();
    for (const src of ["/icon-192.png", "/icon-512.png", "/apple-touch-icon.png"]) expect(sw).toContain(`"${src}"`);
  });

  test("the service worker is never cached by the browser, and the app routes fall back to the page", async () => {
    expect((await fetch(`${base}/sw.js`)).headers.get("cache-control")).toBe("no-cache");
    const route = await fetch(`${base}/some/route`);
    expect(route.status).toBe(200);
    expect(await route.text()).toContain('<div id="root">');
  });

  test("unknown files and odd paths are not found, never served from disk", async () => {
    expect((await fetch(`${base}/nope.js`)).status).toBe(404);
    expect((await fetch(`${base}/..%2f..%2fpackage.json`)).status).toBe(404);
    expect(await (await fetch(`${base}/%2e%2e/%2e%2e/etc/passwd`)).text()).not.toContain("root:");
    expect((await fetch(`${base}/__proto__`)).status).toBe(200);
    expect((await fetch(`${base}/constructor.js`)).status).toBe(404);
    expect((await fetch(`${base}/%zz`)).status).toBe(400);
  });

  test("the built-in files do not expose the socket or the info route without the token", async () => {
    expect((await fetch(`${base}/api/info`)).status).toBe(401);
  });
});
