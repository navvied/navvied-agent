import { afterAll, describe, expect, test } from "bun:test";
import { defaultTools, Jobs } from "../src/index.ts";
import { parseHtmlResults, parseJsonResults } from "../src/tools/web-search.ts";
import { toolsFor } from "../src/permissions.ts";
import type { Tool, ToolContext } from "../src/types.ts";

const tool = defaultTools().find((t) => t.name === "WebSearch") as Tool;
const jobs = new Jobs(() => {});
afterAll(() => jobs.close());
const ctx = (extra: Partial<ToolContext> = {}): ToolContext => ({ cwd: "/", signal: new AbortController().signal, emit: () => {}, allowPrivateNetwork: false, jobs, ...extra });

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
    expect(asked).toEqual(["https://html.duckduckgo.com/html/?q=x%20y", "https://lite.duckduckgo.com/lite/?q=x%20y"]);
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
    globalThis.fetch = (async () => new Response("<html></html>")) as unknown as typeof fetch;
    try { expect(await tool.run({ query: "zzz" }, ctx())).toBe('No results for "zzz". Try other words: {"query":"zzz documentation"}'); } finally { globalThis.fetch = real; }
  });
});
