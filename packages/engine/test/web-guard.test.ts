import { afterEach, describe, expect, test } from "bun:test";
import { defaultTools } from "../src/index.ts";
import { pages } from "../src/tools/web-cache.ts";
import { refusal, vet, web } from "../src/tools/web-guard.ts";
import type { ToolContext } from "../src/types.ts";

const real = { fetch: web.fetch, addresses: web.addresses };
afterEach(() => { web.fetch = real.fetch; web.addresses = real.addresses; pages.clear(); for (const n of ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "https_proxy", "http_proxy", "all_proxy"]) delete process.env[n]; });
const ctx = (more: Partial<ToolContext> = {}): ToolContext => ({ cwd: "/", signal: new AbortController().signal, emit: () => {}, allowPrivateNetwork: false, window: 32_000, ...more } as ToolContext);
const fetchTool = defaultTools().find((t) => t.name === "WebFetch")!;

describe("an address that carries a secret is not fetched", () => {
  const KEY = "sk-" + "a1B2c3D4e5F6g7H8i9J0";
  test("a key or a token in the query, in encoded form, or as the sign-in of the address", async () => {
    web.addresses = async () => ["93.184.216.34"];
    for (const u of [`https://x.example.com/p?api=${KEY}`, `https://x.example.com/p?a=1&t=${encodeURIComponent(KEY)}`, `https://${KEY}@x.example.com/`, "https://x.example.com/p?auth=Bearer%20abcdefghijklmnopqrstuvwx", `https://x.example.com/?k=ghp_${"A1b2".repeat(6)}`]) {
      expect(await refusal(new URL(u), false), u).toContain("looks like a key or a token");
      expect(await refusal(new URL(u), true), u).toContain("looks like a key or a token");
    }
  });
  test("a value of the environment that is a secret is one wherever it is spelled in the address", async () => {
    process.env.NAVVIED_TEST_API_TOKEN = "the-value-of-this-token-1234";
    try { expect(await refusal(new URL("https://x.example.com/?q=the-value-of-this-token-1234"), true)).toContain("looks like a key or a token"); } finally { delete process.env.NAVVIED_TEST_API_TOKEN; }
  });
  test("what is not a secret is: a path that looks like a name, an ordinary query, a short value", async () => {
    web.addresses = async () => ["93.184.216.34"];
    for (const u of ["https://x.example.com/blog/sk-learn-introduction-to-machine-learning", "https://x.example.com/search?q=bun+runtime&page=2", "https://x.example.com/?id=12345678", "https://x.example.com/docs#sk-abcdefghijklmnopqrstuvwxyz"]) expect(await refusal(new URL(u), false), u).toBeUndefined();
  });
  test("WebFetch says so and visits nothing; a redirect to such an address is stopped the same way", async () => {
    let visits = 0;
    web.addresses = async () => ["93.184.216.34"];
    web.fetch = async (_u, _i, _p) => { visits++; return new Response(null, { status: 302, headers: { location: `/next?key=${KEY}` } }); };
    expect(await fetchTool.run({ url: `https://x.example.com/?key=${KEY}` }, ctx())).toBe("Error: the address carries what looks like a key or a token, and secrets do not belong in addresses; it was not fetched.");
    expect(visits).toBe(0);
    expect(await fetchTool.run({ url: "https://x.example.com/start" }, ctx())).toContain("secrets do not belong in addresses");
    expect(visits).toBe(1);
  });
});

describe("the visit goes to the address that was checked", () => {
  test("the addresses found public are what the request is pinned to, for the first address and for every hop", async () => {
    const pins: (readonly string[])[] = [];
    web.addresses = async (h) => (h === "a.example.com" ? ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"] : ["198.51.100.7"]);
    web.fetch = async (u, _i, pin = []) => { pins.push(pin); return u.pathname === "/one" ? new Response(null, { status: 302, headers: { location: "/two" } }) : new Response("done", { headers: { "content-type": "text/plain" } }); };
    expect(await fetchTool.run({ url: "https://a.example.com/one" }, ctx())).toContain("done");
    expect(pins).toEqual([["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"], ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"]]);
  });
  test("an address written as numbers, a host the person opened up, and a request through a proxy are not pinned", async () => {
    expect(await vet(new URL("https://93.184.216.34/"), false)).toEqual({ pin: [] });
    expect(await vet(new URL("http://127.0.0.1:9/"), true)).toEqual({ pin: [] });
    web.addresses = async () => ["93.184.216.34"];
    expect(await vet(new URL("https://name.example.com/"), false)).toEqual({ pin: ["93.184.216.34"] });
    process.env.HTTPS_PROXY = "http://proxy.invalid:3128";
    expect(await vet(new URL("https://name.example.com/"), false)).toEqual({ pin: [] });
    expect(await vet(new URL("http://name.example.com/"), false)).toEqual({ pin: ["93.184.216.34"] });
  });
  test("a name that changes its answer after the check reaches nothing the check did not allow: the connection never looks the name up again", async () => {
    const seen: { host: string | null; agent: string | null }[] = [];
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => { seen.push({ host: req.headers.get("host"), agent: req.headers.get("user-agent") }); return new Response("the pinned answer"); } });
    try {
      // ".invalid" can never be looked up: only a connection to the address that was given can answer.
      const res = await web.fetch(new URL(`http://rebinding.invalid:${server.port}/page`), { headers: { "user-agent": "navvied-test" } }, ["127.0.0.1"]);
      expect(await res.text()).toBe("the pinned answer");
      expect(seen).toEqual([{ host: `rebinding.invalid:${server.port}`, agent: "navvied-test" }]);
    } finally { await server.stop(true); }
  });
  test("an address that never answers does not use up the time of the next one", async () => {
    // The same port on two loopback addresses: the first accepts and says nothing, the second answers. Where the second address cannot be bound (macOS has only 127.0.0.1) there is nothing to check.
    const quiet = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {}, open() {} } });
    let server: ReturnType<typeof Bun.serve> | undefined;
    try { server = Bun.serve({ port: quiet.port, hostname: "127.0.0.2", fetch: () => new Response("answered") }); } catch { quiet.stop(true); return; }
    const before = web.attemptMs;
    web.attemptMs = 300;
    try {
      const t0 = Date.now();
      const res = await web.fetch(new URL(`http://rebinding.invalid:${quiet.port}/`), {}, ["127.0.0.1", "127.0.0.2"]);
      expect(await res.text()).toBe("answered");
      expect(Date.now() - t0).toBeLessThan(5_000);
    } finally { web.attemptMs = before; quiet.stop(true); await server.stop(true); }
  });
  test("an address that does not connect moves on to the next one; any other failure is the answer", async () => {
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("second") });
    const before = web.attemptMs;
    web.attemptMs = 400;
    try {
      const res = await web.fetch(new URL(`http://rebinding.invalid:${server.port}/`), {}, ["127.0.0.2", "127.0.0.1"]).catch(() => undefined);
      // Where 127.0.0.2 is not served the connection is refused (Linux) or goes nowhere (macOS): either way the next address answers; where it is served, the same server answers too.
      expect(res === undefined ? "" : await res.text()).toBe("second");
    } finally { web.attemptMs = before; await server.stop(true); }
  });
});
