import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { defaultTools, Jobs } from "../src/index.ts";
import { USER_AGENT } from "../src/tools/user-agent.ts";
import { mcpText, parseExaResults, parseListedResults, parseParallelResults, RING } from "../src/tools/web-search-ring.ts";
import { backends, inOrder } from "../src/tools/web-search-backends.ts";
import { SearchCache, searches } from "../src/tools/web-search-cache.ts";
import type { Tool, ToolContext } from "../src/types.ts";

const tool = defaultTools().find((t) => t.name === "WebSearch") as Tool;
const jobs = new Jobs(() => {});
afterAll(() => jobs.close());
const ctx = (search: ToolContext["search"] = {}): ToolContext => ({ cwd: "/", signal: new AbortController().signal, emit: () => {}, allowPrivateNetwork: false, jobs, search });
beforeEach(() => searches.clear());

/** Each file is what the service really answered on 2026-11-25 to one request from this program (see the parity note for how it was made). */
const fixture = (name: string): string => readFileSync(join(import.meta.dir, "fixtures", "search", name), "utf8");

interface Seen { url: string; method: string; headers: Headers; body: string }
const withFetch = async (answer: (seen: Seen) => Response | Error, run: (asked: Seen[]) => Promise<void>): Promise<void> => {
  const real = globalThis.fetch;
  const asked: Seen[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const seen = { url: String(url), method: init?.method ?? "GET", headers: new Headers(init?.headers), body: String(init?.body ?? "") };
    asked.push(seen);
    const a = answer(seen);
    if (a instanceof Error) throw a;
    return a;
  }) as unknown as typeof fetch;
  try { await run(asked); } finally { globalThis.fetch = real; }
};
const host = (s: Seen): string => new URL(s.url).hostname;
const SELF_SIGNED = Object.assign(new TypeError("self signed certificate"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" });
const sse = (text: string): Response => new Response(`event: message\ndata: ${JSON.stringify({ result: { content: [{ type: "text", text }] }, jsonrpc: "2.0", id: 1 })}\n\n`, { headers: { "content-type": "text/event-stream" } });
const hit = (title: string): string => JSON.stringify({ results: [{ title, url: "https://r.example/a", content: "About", snippet: "About" }] });

describe("each vendor of the ring is read from an answer it really sent", () => {
  test("Exa: blocks of Title, URL and Highlights", () => {
    const got = mcpText(fixture("exa.sse"));
    expect("text" in got).toBe(true);
    const hits = parseExaResults((got as { text: string }).text);
    expect(hits.length).toBeGreaterThanOrEqual(2);
    expect(hits[0]).toMatchObject({ title: "Bun — A fast all-in-one JavaScript runtime", url: "https://bun.com/" });
    expect(hits.every((h) => /^https?:\/\//.test(h.url) && h.title && h.snippet)).toBe(true);
    expect(hits[0]!.snippet).not.toMatch(/^(Title|URL):/m);
  });
  test("Parallel: JSON inside the answer's text, with the excerpts as the summary", () => {
    const got = mcpText(fixture("parallel.json"));
    const hits = parseParallelResults((got as { text: string }).text);
    expect(hits.length).toBeGreaterThanOrEqual(3);
    expect(hits[0]).toMatchObject({ title: "Bun — A fast all-in-one JavaScript runtime", url: "https://bun.com/" });
    expect(hits[0]!.snippet.length).toBeGreaterThan(20);
  });
  test("Keenable and Tavily: a list of results with a snippet or a content", () => {
    const k = parseListedResults(fixture("keenable.json"));
    expect(k[0]).toMatchObject({ title: "Welcome to Bun | Bun Docs", url: "https://bun.com/docs" });
    expect(k[0]!.snippet).toContain("Runtime");
    const t = parseListedResults(fixture("tavily.json"));
    expect(t[0]).toMatchObject({ url: "https://last9.io/blog/getting-started-with-bun-js" });
    expect(t.every((h) => h.title && h.snippet)).toBe(true);
    expect(parseListedResults("not json")).toEqual([]);
  });
  test("an answer of another shape, a vendor's error and a vendor's limit are told apart", () => {
    expect(mcpText("<html>captive portal</html>")).toEqual({ failed: "blocked" });
    expect(mcpText(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Rate limit exceeded, try later" } }))).toEqual({ failed: "status", status: 429 });
    expect(mcpText(JSON.stringify({ result: { isError: true, content: [{ type: "text", text: "Free tier is busy\nplease wait" }] } }))).toEqual({ failed: "status", status: 502, said: "Free tier is busy please wait" });
  });
});

describe("what the ring sends", () => {
  test("each vendor gets its own request, the honest program name, and no key", async () => {
    await withFetch((s) => (s.url.includes("exa") ? sse("Title: T\nURL: https://a.example\nHighlights:\nAbout") : new Response("{}", { status: 500 })), async (asked) => {
      for (const b of RING) await b.ask("bun runtime", 3, new AbortController().signal);
      const by = Object.fromEntries(asked.map((s) => [host(s), s]));
      expect(Object.keys(by).sort()).toEqual(["api.keenable.ai", "api.tavily.com", "mcp.exa.ai", "search.parallel.ai"]);
      for (const s of asked) {
        expect(s.method).toBe("POST");
        expect(s.headers.get("user-agent")).toBe(USER_AGENT);
        expect(s.headers.get("content-type")).toBe("application/json");
        expect(s.headers.get("authorization")).toBeNull();
      }
      expect(by["mcp.exa.ai"]!.url).toBe("https://mcp.exa.ai/mcp");
      expect(by["mcp.exa.ai"]!.headers.get("accept")).toBe("application/json, text/event-stream");
      expect(JSON.parse(by["mcp.exa.ai"]!.body)).toEqual({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "web_search_exa", arguments: { query: "bun runtime", numResults: 3 } } });
      expect(by["search.parallel.ai"]!.url).toBe("https://search.parallel.ai/mcp");
      const p = JSON.parse(by["search.parallel.ai"]!.body).params;
      expect(p.name).toBe("web_search");
      expect(p.arguments).toMatchObject({ objective: "bun runtime", search_queries: ["bun runtime"] });
      expect(p.arguments.session_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(by["api.keenable.ai"]!.url).toBe("https://api.keenable.ai/v1/search/public");
      expect(by["api.keenable.ai"]!.headers.get("x-keenable-title")).toBe("navvied");
      expect(JSON.parse(by["api.keenable.ai"]!.body)).toEqual({ query: "bun runtime", max_results: 3 });
      expect(by["api.tavily.com"]!.url).toBe("https://api.tavily.com/search");
      expect(by["api.tavily.com"]!.headers.get("x-tavily-access-mode")).toBe("keyless");
      expect(JSON.parse(by["api.tavily.com"]!.body)).toMatchObject({ query: "bun runtime", max_results: 3 });
    });
  });
});

describe("the ring and what follows it", () => {
  test("the order of the ring turns by one for each search, and the public pages, navvied's search and the encyclopedia always follow", () => {
    const ids = (start: number): string[] => inOrder(undefined, undefined, start).map((b) => b.id);
    const tail = ["duckduckgo", "duckduckgo-lite", "navvied", "wikipedia"];
    expect(ids(0)).toEqual(["exa", "parallel", "keenable", "tavily", ...tail]);
    expect(ids(1)).toEqual(["parallel", "keenable", "tavily", "exa", ...tail]);
    expect(ids(3)).toEqual(["tavily", "exa", "parallel", "keenable", ...tail]);
    const firsts = new Set(Array.from({ length: 8 }, () => inOrder(undefined)[0]!.id));
    expect(firsts.size).toBe(4);
    expect(backends().map((b) => b.id)).toContain("keenable");
  });
  test("an order the person names is followed exactly, ring names included, with no turning", () => {
    expect(inOrder(["tavily", "wikipedia", "exa"], undefined, 2).map((b) => b.id)).toEqual(["tavily", "wikipedia", "exa"]);
  });

  test("a vendor that cannot be reached (TLS, network, time out) or that refuses hands over to the next, and the next one's answer is the answer", async () => {
    const cases: [string, Response | Error][] = [
      ["a certificate that is not its own", SELF_SIGNED],
      ["a network that does not connect", new Error("Unable to connect. Is the computer able to access the url?")],
      ["no answer in time", new DOMException("timed out", "TimeoutError")],
      ["a limit", new Response("slow down", { status: 429 })],
      ["a refusal", new Response("{}", { status: 403 })],
      ["a server error", new Response("", { status: 503 })],
    ];
    for (const [name, failure] of cases) {
      searches.clear();
      await withFetch((s) => (host(s) === "api.tavily.com" ? Response.json({ results: [{ title: "Found", url: "https://found.example/", content: "yes" }] }) : failure), async (asked) => {
        const out = await tool.run({ query: `q ${name}` }, ctx({ order: ["exa", "parallel", "keenable", "tavily"] }));
        expect(asked.map(host), name).toEqual(["mcp.exa.ai", "search.parallel.ai", "api.keenable.ai", "api.tavily.com"]);
        expect(out, name).toContain("1. Found\n   https://found.example/\n   yes");
        expect(out, name).toContain("These results are from Tavily.");
      });
    }
  });

  test("the ring first, then DuckDuckGo, then the rest: a whole ring that fails ends at the public page, and says why the first one failed in words", async () => {
    await withFetch((s) => (host(s) === "html.duckduckgo.com" ? new Response(readFileSync(join(import.meta.dir, "fixtures", "search", "duckduckgo-results.html"), "utf8")) : SELF_SIGNED), async (asked) => {
      const out = await tool.run({ query: "ring then page" }, ctx());
      const hosts = asked.map(host);
      expect(new Set(hosts.slice(0, 4))).toEqual(new Set(["mcp.exa.ai", "search.parallel.ai", "api.keenable.ai", "api.tavily.com"]));
      expect(hosts[4]).toBe("html.duckduckgo.com");
      expect(out).toMatch(/^Note: (Exa|Parallel|Keenable|Tavily) could not be reached safely from this network/);
      expect(out).toContain("These results are from DuckDuckGo.");
    });
  });

  test("when every rung fails the first reason is said with what the person can do", async () => {
    await withFetch(() => new Response("slow", { status: 429 }), async () => {
      const out = await tool.run({ query: "all fail" }, ctx({ order: ["exa", "tavily"] }));
      expect(out).toMatch(/^Error: (Exa|Tavily) is limiting its free searches for now\. Do not search again; say so to the user/);
    });
  });

  test("a vendor that answers and finds nothing is an answer: the next is not asked", async () => {
    await withFetch(() => Response.json({ results: [] }), async (asked) => {
      expect(await tool.run({ query: "nothing here" }, ctx({ order: ["keenable", "tavily"] }))).toStartWith('No results for "nothing here"');
      expect(asked).toHaveLength(1);
    });
  });

  test("NAVVIED_SEARCH_URL still wins alone: no vendor is asked", async () => {
    const server = Bun.serve({ port: 0, fetch: () => Response.json({ results: [{ title: "Own", url: "https://own.example", content: "" }] }) });
    try {
      const real = globalThis.fetch;
      const seen: string[] = [];
      globalThis.fetch = ((url: string, init?: RequestInit) => { seen.push(String(url)); return real(url, init); }) as typeof fetch;
      try { expect(await tool.run({ query: "own" }, ctx({ url: `http://127.0.0.1:${server.port}/s` }))).toContain("1. Own"); } finally { globalThis.fetch = real; }
      expect(seen.map((u) => new URL(u).hostname)).toEqual(["127.0.0.1"]);
    } finally { await server.stop(true); }
  });
});

describe("the answers of searches made lately", () => {
  test("the same words and limit are not sent twice; other words, another limit or another order are", async () => {
    await withFetch(() => Response.json({ results: [{ title: "A", url: "https://a.example", content: "x" }] }), async (asked) => {
      const run = (query: string, max?: number, order = ["tavily"]) => tool.run({ query, ...(max ? { max_results: max } : {}) }, ctx({ order }));
      const first = await run("Same Words");
      expect(await run("same words")).toBe(first);
      expect(asked).toHaveLength(1);
      await run("same words", 3);
      await run("other words");
      await run("same words", undefined, ["keenable"]);
      expect(asked).toHaveLength(4);
    });
  });
  test("two searches at once for the same words share one request", async () => {
    await withFetch(() => Response.json({ results: [{ title: "A", url: "https://a.example", content: "x" }] }), async (asked) => {
      const c = ctx({ order: ["tavily"] });
      const [a, b] = await Promise.all([tool.run({ query: "together" }, c), tool.run({ query: "together" }, c)]);
      expect(a).toBe(b);
      expect(asked).toHaveLength(1);
    });
  });
  test("a failure and an empty answer are never kept", async () => {
    let fail = true;
    await withFetch(() => (fail ? new Response("", { status: 503 }) : Response.json({ results: [{ title: "A", url: "https://a.example", content: "x" }] })), async (asked) => {
      const c = ctx({ order: ["tavily"] });
      expect(await tool.run({ query: "later" }, c)).toStartWith("Error:");
      fail = false;
      expect(await tool.run({ query: "later" }, c)).toContain("1. A");
      expect(asked).toHaveLength(2);
    });
  });
  test("an answer is kept for 20 minutes and no longer", async () => {
    let now = 1_000;
    const cache = new SearchCache(20 * 60_000, 50, () => now);
    let made = 0;
    const make = async (): Promise<string> => `answer ${++made}`;
    expect(await cache.get("k", make, () => true)).toBe("answer 1");
    now += 19 * 60_000;
    expect(await cache.get("k", make, () => true)).toBe("answer 1");
    now += 2 * 60_000;
    expect(await cache.get("k", make, () => true)).toBe("answer 2");
  });
});
