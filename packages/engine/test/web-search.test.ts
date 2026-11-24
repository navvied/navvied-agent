import { afterAll, describe, expect, test } from "bun:test";
import { defaultTools, Jobs } from "../src/index.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseHtmlResults, parseJsonResults, parseLiteResults, parseWikipediaResults } from "../src/tools/web-search.ts";
import { backends, inOrder } from "../src/tools/web-search-backends.ts";
import { unreachedSentence, whyUnreached } from "../src/tools/web-errors.ts";
import { toolsFor } from "../src/permissions.ts";
import type { Tool, ToolContext } from "../src/types.ts";

const tool = defaultTools().find((t) => t.name === "WebSearch") as Tool;
const jobs = new Jobs(() => {});
afterAll(() => jobs.close());
const ctx = (extra: Partial<ToolContext> = {}): ToolContext => ({ cwd: "/", signal: new AbortController().signal, emit: () => {}, allowPrivateNetwork: false, jobs, ...extra });

const fixture = (name: string): string => readFileSync(join(import.meta.dir, "fixtures", "search", name), "utf8");

const PAGE = `
<div class="result results_links">
  <h2><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpricing%3Fa%3D1&amp;rut=abc">Example <b>Shop</b> pricing</a></h2>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=x">Three plans &amp; a free one, from $5.</a>
</div>
<div class="result">
  <a class="result__a" href="https://direct.example.org/page">Direct link</a>
  <a class="result__snippet" href="#">A &quot;direct&quot; result.</a>
</div>
<div class="result"><a class="result__a" href="javascript:alert(1)">Not a web address</a></div>
<div class="result"><a class="result__a" href="https://no-snippet.example/">No snippet here</a></div>`;

describe("reading a search page", () => {
  test("titles, the real addresses behind the redirect, and summaries, with markup and entities removed", () => {
    expect(parseHtmlResults(PAGE)).toEqual([
      { title: "Example Shop pricing", url: "https://example.com/pricing?a=1", snippet: "Three plans & a free one, from $5." },
      { title: "Direct link", url: "https://direct.example.org/page", snippet: 'A "direct" result.' },
      { title: "No snippet here", url: "https://no-snippet.example/", snippet: "" },
    ]);
  });
  test("a page with nothing to read gives nothing, and a JSON answer is read the same way", () => {
    expect(parseHtmlResults("<html>nothing</html>")).toEqual([]);
    expect(parseJsonResults({ results: [{ title: "T", url: "https://a.example", content: "C" }, { title: "no url" }, null] })).toEqual([{ title: "T", url: "https://a.example", snippet: "C" }]);
    expect(parseJsonResults("x")).toEqual([]);
  });
});

describe("the WebSearch tool", () => {
  test("it is read-only, and any model is offered it only when the request is about the web (a chat always)", () => {
    expect(tool.readOnly).toBe(true);
    const all = defaultTools();
    const names = (userText: string) => toolsFor("auto", all, { small: true, userText, jobs: 0 }).map((t) => t.name);
    expect(names("fix the bug in a.ts")).not.toContain("WebSearch");
    expect(names("search the web for the latest news")).toContain("WebSearch");
    expect(toolsFor("auto", all, { small: false, userText: "fix the bug in a.ts", jobs: 0 }).map((t) => t.name)).not.toContain("WebSearch");
    expect(toolsFor("auto", all, { small: false, userText: "what is the latest version", jobs: 0 }).map((t) => t.name)).toContain("WebSearch");
    // A web service the project runs is not a reason to offer the web.
    expect(toolsFor("auto", all, { small: false, userText: "start the web service and wait until it answers", jobs: 0 }).map((t) => t.name)).not.toEqual(expect.arrayContaining(["WebSearch"]));
    expect(toolsFor("auto", all, { small: false, userText: "start the web service and wait until it answers", jobs: 0 }).map((t) => t.name)).not.toContain("WebFetch");
    expect(toolsFor("auto", all, { small: false, userText: "hello", jobs: 0, chat: true }).map((t) => t.name)).toContain("WebSearch");
  });
  test("asks the configured search server, numbers the results and limits how many", async () => {
    const seen: string[] = [];
    const server = Bun.serve({ port: 0, fetch(req) { seen.push(new URL(req.url).search); return Response.json({ results: Array.from({ length: 8 }, (_, i) => ({ title: `Result ${i}`, url: `https://r${i}.example`, content: `About ${i}` })) }); } });
    try {
      const out = await tool.run({ query: "kurs usd idr", max_results: 3 }, ctx({ search: { url: `http://127.0.0.1:${server.port}/search` } }));
      expect(seen[0]).toBe("?q=kurs%20usd%20idr&format=json");
      expect(out).toContain('Results for "kurs usd idr":');
      expect(out).toContain("1. Result 0\n   https://r0.example\n   About 0");
      expect(out).toContain("3. Result 2");
      expect(out).not.toContain("4. Result 3");
    } finally { await server.stop(true); }
  });
  test("an empty query, a server error and a search page that wants a human are said plainly", async () => {
    expect(await tool.run({ query: "  " }, ctx())).toBe('Error: the query is empty. Retry: WebSearch {"query":"words to look for"}');
    const server = Bun.serve({ port: 0, fetch: () => new Response("no", { status: 503 }) });
    try { expect(await tool.run({ query: "x" }, ctx({ search: { url: `http://127.0.0.1:${server.port}/s` } }))).toBe("Error: the search server answered 503."); } finally { await server.stop(true); }
    const real = globalThis.fetch;
    const asked: string[] = [];
    globalThis.fetch = (async (url: string) => { asked.push(String(url)); return new Response("<html>Unfortunately, bots use DuckDuckGo too. anomaly-modal challenge</html>", { status: 202 }); }) as unknown as typeof fetch;
    try { expect(await tool.run({ query: "x y" }, ctx())).toContain("asked for a human check"); } finally { globalThis.fetch = real; }
    // The lighter page of the same engine is tried once before giving up.
    expect(asked.slice(0, 2)).toEqual(["https://html.duckduckgo.com/html/?q=x%20y", "https://lite.duckduckgo.com/lite/?q=x%20y"]);
  });
  test("when the full page asks for a human check, the lighter page of the engine answers instead", async () => {
    const real = globalThis.fetch;
    const lite = `<table><tr><td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fa&rut=x" class='result-link'>Example A</a></td></tr><tr><td class='result-snippet'>About <b>A</b></td></tr>
      <tr><td><a class='result-link' href="https://example.org/b">Example B</a></td></tr><tr><td class='result-snippet'>${"long ".repeat(80)}</td></tr></table>`;
    globalThis.fetch = (async (url: string) => (String(url).includes("lite.") ? new Response(lite) : new Response("<html>anomaly challenge</html>", { status: 202 }))) as unknown as typeof fetch;
    try {
      const out = await tool.run({ query: "x" }, ctx());
      expect(out).toContain("1. Example A\n   https://example.org/a\n   About A");
      expect(out).toContain("2. Example B\n   https://example.org/b");
      expect(out.split("\n").every((l) => l.length <= 230)).toBe(true);
    } finally { globalThis.fetch = real; }
  });
  test("no results is an answer, not an error", async () => {
    const real = globalThis.fetch;
    const asked: string[] = [];
    globalThis.fetch = (async (url: string) => { asked.push(String(url)); return new Response(fixture("duckduckgo-none.html")); }) as unknown as typeof fetch;
    try { expect(await tool.run({ query: "zzz" }, ctx())).toBe('No results for "zzz". Try other words: {"query":"zzz documentation"}'); } finally { globalThis.fetch = real; }
    // The engine's own page with nothing on it is an answer: no other site is asked.
    expect(asked).toHaveLength(1);
  });
});

/** The error a failed certificate check gives (read from a real self-signed server). */
const SELF_SIGNED = Object.assign(new TypeError("self signed certificate"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" });
/** What a network that blocks a site answers in its place: its own page, with a status that says all is well. */
const BLOCK_PAGE = "<html><head><title>Internet Positif</title></head><body>The site you tried to reach is blocked.</body></html>";

const withFetch = async (answer: (url: string) => Response | Error, run: (asked: string[]) => Promise<void>): Promise<void> => {
  const real = globalThis.fetch;
  const asked: string[] = [];
  globalThis.fetch = (async (url: string) => { asked.push(String(url)); const a = answer(String(url)); if (a instanceof Error) throw a; return a; }) as unknown as typeof fetch;
  try { await run(asked); } finally { globalThis.fetch = real; }
};
const wikipedia = (url: string): boolean => url.includes("wikipedia.org");

describe("each search site is read from a page it really sent", () => {
  test("DuckDuckGo's results page, its page with no results, the lighter page and the encyclopedia's answer", () => {
    const found = parseHtmlResults(fixture("duckduckgo-results.html"));
    expect(found.length).toBe(3);
    expect(found.every((h) => /^https?:\/\//.test(h.url) && h.title.length > 0)).toBe(true);
    expect(found.some((h) => h.url.includes("duckduckgo.com/l/"))).toBe(false);
    expect(parseHtmlResults(fixture("duckduckgo-none.html"))).toEqual([]);
    expect(parseLiteResults(fixture("duckduckgo-lite.html")).map((h) => h.url)).toEqual(["https://example.org/a", "https://example.org/b"]);
    const wiki = parseWikipediaResults(JSON.parse(fixture("wikipedia.json")));
    expect(wiki.map((h) => h.title)).toEqual(["Glyph Lefkowitz", "Tornado (web server)", "Async/await"]);
    expect(wiki[1]).toMatchObject({ url: "https://en.wikipedia.org/wiki/Tornado_(web_server)" });
    expect(wiki.some((h) => /[<>]|&quot;/.test(h.snippet))).toBe(false);
    expect(parseWikipediaResults({})).toEqual([]);
  });
});

describe("a network that blocks a search site", () => {
  test("a certificate that is not the site's own is told in words, and never accepted", async () => {
    expect(whyUnreached(SELF_SIGNED)).toBe("tls");
    expect(whyUnreached(Object.assign(new Error("unable to verify the first certificate"), { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" }))).toBe("tls");
    expect(whyUnreached(new Error("The operation timed out"))).toBe("timeout");
    expect(whyUnreached(new Error("Unable to connect. Is the computer able to access the url?"))).toBe("network");
    expect(unreachedSentence("tls", "DuckDuckGo")).toBe("DuckDuckGo could not be reached safely from this network: its certificate is not the site's own, which usually means the network blocks it.");
    await withFetch(() => SELF_SIGNED, async () => {
      const out = await tool.run({ query: "kurs" }, ctx());
      expect(out).toContain("could not be reached safely from this network");
      expect(out).not.toContain("self signed certificate");
      expect(out).toContain("NAVVIED_SEARCH_URL");
    });
    // Nothing in the program turns certificate checking off.
    expect(readFileSync(join(import.meta.dir, "../src/tools/web-search-backends.ts"), "utf8")).not.toMatch(/rejectUnauthorized|NODE_TLS_REJECT/);
  });

  test("the next site is asked, and its results are said to come from it", async () => {
    await withFetch((url) => (wikipedia(url) ? new Response(fixture("wikipedia.json")) : SELF_SIGNED), async (asked) => {
      const out = await tool.run({ query: "python asyncio" }, ctx());
      expect(asked.map((u) => new URL(u).hostname)).toEqual(["html.duckduckgo.com", "lite.duckduckgo.com", "en.wikipedia.org"]); // navvied search is not asked where nobody says where it is
      expect(out).toContain("Note: DuckDuckGo could not be reached safely from this network");
      expect(out).toContain("These results are from Wikipedia.");
      expect(out).toContain("1. Glyph Lefkowitz\n   https://en.wikipedia.org/wiki/Glyph_Lefkowitz");
    });
  });

  test("a page of the network's own in the engine's place is not an answer: the next site is asked", async () => {
    await withFetch((url) => (wikipedia(url) ? new Response(fixture("wikipedia.json")) : new Response(BLOCK_PAGE)), async (asked) => {
      const out = await tool.run({ query: "x" }, ctx());
      expect(asked).toHaveLength(3);
      expect(out).toContain("answered with a page that is not its own");
      expect(out).toContain("These results are from Wikipedia.");
    });
  });

  test("a site that answers well after one that did not is the answer; the lighter page of the same engine counts", async () => {
    await withFetch((url) => (url.includes("lite.") ? new Response(fixture("duckduckgo-lite.html")) : SELF_SIGNED), async (asked) => {
      const out = await tool.run({ query: "x" }, ctx());
      expect(asked).toHaveLength(2);
      expect(out).toContain("1. Example A\n   https://example.org/a");
      expect(out).not.toContain("Note:");
    });
  });

  test("when no site can be reached the first reason is said, with what the person can do, and nothing else is claimed", async () => {
    await withFetch(() => SELF_SIGNED, async () => {
      const out = await tool.run({ query: "x" }, ctx());
      expect(out.startsWith("Error: DuckDuckGo could not be reached safely from this network")).toBe(true);
      expect(out).toContain("Do not search again; say so to the user");
    });
    await withFetch(() => new Error("Unable to connect. Is the computer able to access the url?"), async () => {
      expect(await tool.run({ query: "x" }, ctx())).toContain("DuckDuckGo could not be reached from this network.");
    });
    await withFetch(() => new Response("no", { status: 503 }), async () => {
      expect(await tool.run({ query: "x" }, ctx())).toContain("DuckDuckGo answered 503.");
    });
  });

  test("the encyclopedia finding nothing, after a site that could not be reached, does not turn into a made-up empty answer", async () => {
    await withFetch((url) => (wikipedia(url) ? Response.json({ query: { search: [] } }) : SELF_SIGNED), async () => {
      expect((await tool.run({ query: "x" }, ctx())).startsWith("Error: DuckDuckGo could not be reached safely")).toBe(true);
    });
  });

  test("a search server of the person's own still wins, and a certificate failure there is told in words too", async () => {
    await withFetch(() => SELF_SIGNED, async (asked) => {
      const out = await tool.run({ query: "x" }, ctx({ search: { url: "https://search.example/s" } }));
      expect(asked).toEqual(["https://search.example/s?q=x&format=json"]);
      expect(out).toBe("Error: The search server could not be reached safely from this network: its certificate is not the site's own, which usually means the network blocks it.");
    });
  });

  test("the order is the person's: unknown names are ignored, an empty list is the default", async () => {
    expect(inOrder(["wikipedia", "nonsense", "duckduckgo", "wikipedia"]).map((b) => b.id)).toEqual(["wikipedia", "duckduckgo"]);
    expect(inOrder([]).map((b) => b.id)).toEqual(["duckduckgo", "duckduckgo-lite", "navvied", "wikipedia"]);
    expect(inOrder(["x"]).map((b) => b.id)).toEqual(["duckduckgo", "duckduckgo-lite", "navvied", "wikipedia"]);
    expect(backends().map((b) => b.id)).toEqual(["duckduckgo", "duckduckgo-lite", "wikipedia", "navvied"]);
    await withFetch((url) => (wikipedia(url) ? new Response(fixture("wikipedia.json")) : SELF_SIGNED), async (asked) => {
      const out = await tool.run({ query: "x" }, ctx({ search: { order: ["wikipedia", "duckduckgo"] } }));
      expect(asked.map((u) => new URL(u).hostname)).toEqual(["en.wikipedia.org"]);
      expect(out).not.toContain("Note:");
    });
  });

  test("a site that is stopped by the person ends the search", async () => {
    const stop = new AbortController();
    await withFetch(() => { stop.abort(); return SELF_SIGNED; }, async (asked) => {
      await tool.run({ query: "x" }, ctx({ signal: stop.signal }));
      expect(asked).toHaveLength(1);
    });
  });
});

describe("navvied's own search, for a computer whose network blocks the public pages", () => {
  const found = { results: [{ title: "Kurs hari ini", url: "https://example.id/kurs", snippet: "Nilai tukar" }] };
  const serve = (answer: (req: Request) => Response) => {
    const seen: { path: string; auth: string | null }[] = [];
    const server = Bun.serve({ port: 0, fetch(req) { const u = new URL(req.url); seen.push({ path: u.pathname + u.search, auth: req.headers.get("authorization") }); return answer(req); } });
    return { seen, server, at: (token?: string) => () => ({ server: `http://127.0.0.1:${server.port}`, ...(token ? { token } : {}) }) };
  };

  test("it comes after the public pages and before the encyclopedia, asks with the account's token, and its results are said to be from it", async () => {
    const s = serve(() => Response.json(found));
    try {
      await withFetch((url) => (url.startsWith("http://127.0.0.1") ? new Response(JSON.stringify(found)) : SELF_SIGNED), async (asked) => {
        const out = await tool.run({ query: "kurs", max_results: 3 }, ctx({ search: { navvied: () => ({ server: "http://127.0.0.1:1", token: "nv_secret" }) } }));
        expect(asked.map((u) => new URL(u).hostname)).toEqual(["html.duckduckgo.com", "lite.duckduckgo.com", "127.0.0.1"]);
        expect(asked.at(-1)).toBe("http://127.0.0.1:1/api/search?q=kurs&max=3");
        expect(out).toContain("These results are from navvied search.");
        expect(out).toContain("1. Kurs hari ini\n   https://example.id/kurs\n   Nilai tukar");
      });
      const out = await tool.run({ query: "kurs" }, ctx({ search: { order: ["navvied"], navvied: s.at("nv_secret") } }));
      expect(out).toContain("1. Kurs hari ini");
      expect(s.seen).toEqual([{ path: "/api/search?q=kurs&max=5", auth: "Bearer nv_secret" }]);
    } finally { await s.server.stop(true); }
  });

  test("a computer that is not signed in asks as a guest: no token goes", async () => {
    const s = serve(() => Response.json(found));
    try {
      await tool.run({ query: "kurs" }, ctx({ search: { order: ["navvied"], navvied: s.at() } }));
      expect(s.seen[0]!.auth).toBeNull();
    } finally { await s.server.stop(true); }
  });

  test("a sign-in that is not valid is said so and is not tried again as a guest; a limit says what the server said", async () => {
    const unauthorised = serve(() => Response.json({ error: { message: "bad token", type: "authentication" } }, { status: 401 }));
    const limited = serve(() => Response.json({ error: { message: "Today's limit of searches is reached.", type: "rate_limited" } }, { status: 429 }));
    try {
      const a = await tool.run({ query: "x" }, ctx({ search: { order: ["navvied"], navvied: unauthorised.at("nv_old") } }));
      expect(a).toContain("navvied search did not accept this computer's sign-in. Sign in again.");
      expect(unauthorised.seen).toHaveLength(1);
      const b = await tool.run({ query: "x" }, ctx({ search: { order: ["navvied"], navvied: limited.at() } }));
      expect(b).toContain("navvied search: Today's limit of searches is reached.");
    } finally { await unauthorised.server.stop(true); await limited.server.stop(true); }
  });

  test("a server that cannot be reached, or that answers something else, is a rung that did not work", async () => {
    const odd = serve(() => new Response("<html>nope</html>"));
    try {
      expect(await tool.run({ query: "x" }, ctx({ search: { order: ["navvied"], navvied: odd.at() } }))).toContain("answered with a page that is not its own");
      expect(await tool.run({ query: "x" }, ctx({ search: { order: ["navvied"], navvied: () => ({ server: "http://127.0.0.1:1" }) } }))).toContain("navvied search could not be reached");
    } finally { await odd.server.stop(true); }
  });
});

describe("who asks", () => {
  test("every request of search, the navvied rung and the person's own server says what program asks and where to read about it, and never claims to be a browser", async () => {
    const real = globalThis.fetch;
    const seen: { url: string; agent: string | null }[] = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => { seen.push({ url: String(url), agent: new Headers(init?.headers).get("user-agent") }); return new Response("no", { status: 503 }); }) as unknown as typeof fetch;
    try {
      await tool.run({ query: "x" }, ctx({ search: { navvied: () => ({ server: "https://navvied.example" }) } }));
      await tool.run({ query: "x" }, ctx({ search: { url: "https://own.example/s" } }));
    } finally { globalThis.fetch = real; }
    expect(seen.map((r) => new URL(r.url).hostname)).toEqual(["html.duckduckgo.com", "lite.duckduckgo.com", "navvied.example", "en.wikipedia.org", "own.example"]);
    for (const r of seen) expect(r.agent, r.url).toMatch(/^navvied\/\d+\.\d+\.\d+ \(https:\/\/navvied\.com\)$/);
  });
});
