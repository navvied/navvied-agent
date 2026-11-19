import { afterAll, describe, expect, test } from "bun:test";
import { defaultTools, Jobs } from "../src/index.ts";
import type { Tool, ToolContext } from "../src/types.ts";
import { cleanupAll, prompt, rig } from "./helpers.ts";

const seen: { path: string; auth: string | null; body: Record<string, unknown> }[] = [];
let reply: (path: string, body: Record<string, unknown>) => Response = () => new Response("{}");
const service = Bun.serve({
  port: 0,
  async fetch(req) {
    const body = (await req.json()) as Record<string, unknown>;
    const path = new URL(req.url).pathname;
    seen.push({ path, auth: req.headers.get("authorization"), body });
    return reply(path, body);
  },
});
const jobs = new Jobs(() => {});
afterAll(() => { service.stop(true); jobs.close(); cleanupAll(); });

const TOKEN = "grant-secret-123";
const proxy = { url: `http://127.0.0.1:${service.port}/v1/web`, token: TOKEN };
const tool = (name: string): Tool => defaultTools().find((t) => t.name === name)!;
const ctx = (extra: Partial<ToolContext> = {}): ToolContext => ({ cwd: "/", signal: new AbortController().signal, emit: () => {}, allowPrivateNetwork: false, jobs, webProxy: proxy, ...extra });
const json = (status: number, body: unknown): Response => Response.json(body, { status });
const refused = (status: number, message: string): Response => json(status, { error: { message, type: "x" } });

describe("WebFetch in a session that has no network of its own", () => {
  test("asks the service with the session's token, and gives the page back as the tool always does", async () => {
    seen.length = 0;
    reply = () => json(200, { status: 200, contentType: "text/html; charset=utf-8", text: "<html><script>x()</script><h1>Price</h1><p>5&nbsp;dollars</p></html>" });
    const out = await tool("WebFetch").run({ url: "https://shop.invalid/pricing" }, ctx());
    expect(out).toBe("200 text/html; charset=utf-8\nPrice 5 dollars");
    expect(seen).toEqual([{ path: "/v1/web/fetch", auth: `Bearer ${TOKEN}`, body: { url: "https://shop.invalid/pricing" } }]);
  });

  test("a redirect is reported as it is when the page is fetched directly", async () => {
    reply = () => json(200, { status: 302, redirect: "https://elsewhere.invalid/" });
    expect(await tool("WebFetch").run({ url: "https://a.invalid/" }, ctx())).toBe("Redirected (302) to https://elsewhere.invalid/. Fetch that address if it is the one you want.");
  });

  test("what the service refuses is said in its own words, and the token is never in the answer", async () => {
    for (const [status, message] of [[403, "Fetching that address is not allowed."], [429, "Too many fetches. Try again in 12 seconds."], [413, "The answer was too large to read."], [502, "That address did not answer in time."]] as const) {
      reply = () => refused(status, message);
      const out = await tool("WebFetch").run({ url: "https://a.invalid/" }, ctx());
      expect(out).toBe(`Error: ${message}`);
      expect(out).not.toContain(TOKEN);
    }
    reply = () => new Response("not json", { status: 500 });
    expect(await tool("WebFetch").run({ url: "https://a.invalid/" }, ctx())).toBe("Error: the web service answered 500.");
  });

  test("a service that cannot be reached is a sentence, and a text that is not an address never reaches it", async () => {
    seen.length = 0;
    const out = await tool("WebFetch").run({ url: "https://a.invalid/" }, ctx({ webProxy: { url: "http://127.0.0.1:1/v1/web", token: TOKEN } }));
    expect(out).toBe("Error: the web service of this session could not be reached.");
    expect(await tool("WebFetch").run({ url: "ftp://a.invalid/" }, ctx())).toContain("only http(s)");
    expect(await tool("WebFetch").run({ url: "nonsense" }, ctx())).toContain("not a valid URL");
    expect(seen).toEqual([]);
  });
});

describe("WebSearch in a session that has no network of its own", () => {
  test("asks the service, and lists what it found in the usual form", async () => {
    seen.length = 0;
    reply = () => json(200, { results: [{ title: "Lamps", url: "https://lamps.invalid/", snippet: "All the lamps." }, { title: 7, url: "https://bad.invalid/" }, { title: "No summary", url: "https://plain.invalid/" }] });
    const out = await tool("WebSearch").run({ query: "lamps", max_results: 3 }, ctx());
    expect(out).toBe('Results for "lamps":\n\n1. Lamps\n   https://lamps.invalid/\n   All the lamps.\n\n2. No summary\n   https://plain.invalid/');
    expect(seen).toEqual([{ path: "/v1/web/search", auth: `Bearer ${TOKEN}`, body: { query: "lamps", max_results: 3 } }]);
  });

  test("no results, and a refusal in the service's words", async () => {
    reply = () => json(200, { results: [] });
    expect(await tool("WebSearch").run({ query: "zzz" }, ctx())).toBe('No results for "zzz".');
    reply = () => refused(429, "Too many searches. Try again in 30 seconds.");
    expect(await tool("WebSearch").run({ query: "zzz" }, ctx())).toBe("Error: Too many searches. Try again in 30 seconds.");
  });
});

describe("the engine hands the service to its tools", () => {
  test("a hosted session's WebFetch goes through the service, whatever the page, and nothing shows the token", async () => {
    seen.length = 0;
    reply = () => json(200, { status: 200, contentType: "text/plain", text: "hello from the service" });
    const r = rig((req) => (req.messages.at(-1)?.role === "tool" ? { text: "done" } : { calls: [{ name: "WebFetch", args: { url: "https://never-resolves.invalid/" } }] }), { webProxy: proxy });
    await r.turn(prompt("fetch https://never-resolves.invalid/", { mode: "auto" }));
    const shown = JSON.stringify(r.events);
    expect(shown).toContain("hello from the service");
    expect(shown).not.toContain(TOKEN);
    expect(seen.map((s) => s.path)).toEqual(["/v1/web/fetch"]);
    r.cleanup();
  });
});
