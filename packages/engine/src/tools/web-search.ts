import type { Tool } from "../types.ts";
import { clip, num, str } from "./util.ts";
import { viaProxy } from "./web-proxy.ts";

export interface SearchHit { title: string; url: string; snippet: string }

const text = (html: string): string =>
  html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, " ").trim();

/** The real address behind a result link, which the search page wraps in a redirect of its own. */
function target(href: string): string {
  const wrapped = /[?&]uddg=([^&]+)/.exec(href)?.[1];
  const raw = wrapped ? decodeURIComponent(wrapped) : href;
  return raw.startsWith("//") ? `https:${raw}` : raw;
}

/** Results from the plain-HTML page of a public search engine. */
export function parseHtmlResults(html: string): SearchHit[] {
  const hits: SearchHit[] = [];
  const link = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  for (let m = link.exec(html); m; m = link.exec(html)) {
    const next = html.indexOf('class="result__a', m.index + m[0].length);
    const section = html.slice(m.index, next < 0 ? undefined : next);
    const snippet = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/.exec(section)?.[1] ?? "";
    const url = target(m[1]!);
    if (/^https?:\/\//.test(url)) hits.push({ title: text(m[2]!), url, snippet: text(snippet) });
  }
  return hits;
}

/** Results from a search server that answers in JSON, such as SearXNG. */
export function parseJsonResults(body: unknown): SearchHit[] {
  const list = (body as { results?: unknown }).results;
  if (!Array.isArray(list)) return [];
  return list.flatMap((r: unknown) => {
    const hit = (typeof r === "object" && r !== null ? r : {}) as Record<string, unknown>;
    return typeof hit.url === "string" && typeof hit.title === "string" ? [{ title: hit.title, url: hit.url, snippet: typeof hit.content === "string" ? hit.content : "" }] : [];
  });
}

const format = (query: string, hits: SearchHit[]): string =>
  hits.length ? clip(`Results for "${query}":\n\n${hits.map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}${h.snippet ? `\n   ${h.snippet}` : ""}`).join("\n\n")}`) : `No results for "${query}".`;

export const webSearch: Tool = {
  name: "WebSearch",
  readOnly: true,
  offeredWhen: ({ userText, chat }) => chat === true || /\b(search|internet|online|on the web|latest|news|price|look up|google)\b/i.test(userText),
  description: "Search the web: titles, addresses and short summaries.",
  parameters: { type: "object", properties: { query: { type: "string" }, max_results: { type: "number" } }, required: ["query"] },
  title: (a) => `Search the web for ${str(a.query)}`,
  async run(a, ctx) {
    const query = str(a.query).trim();
    if (!query) return "Error: the query is empty.";
    const limit = Math.min(Math.max(1, Math.round(num(a.max_results, 5))), 10);
    const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(20_000)]);
    const configured = ctx.search?.url;
    if (ctx.webProxy) {
      const got = await viaProxy<{ results?: unknown }>(ctx.webProxy, "search", { query, max_results: limit }, signal);
      if (!got.ok) return `Error: ${got.message}`;
      const found = Array.isArray(got.value.results) ? (got.value.results as Partial<SearchHit>[]) : [];
      return format(query, found.flatMap((r) => (typeof r.title === "string" && typeof r.url === "string" ? [{ title: r.title, url: r.url, snippet: typeof r.snippet === "string" ? r.snippet : "" }] : [])).slice(0, limit));
    }
    try {
      if (configured) {
        const res = await fetch(`${configured}${configured.includes("?") ? "&" : "?"}q=${encodeURIComponent(query)}&format=json`, { signal, headers: { accept: "application/json", "user-agent": "navvied-agent" } });
        if (!res.ok) return `Error: the search server answered ${res.status}.`;
        return format(query, parseJsonResults(await res.json()).slice(0, limit));
      }
      const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, { signal, headers: { "user-agent": "Mozilla/5.0 (compatible; navvied-agent)" } });
      if (!res.ok && res.status !== 202) return `Error: the search page answered ${res.status}.`;
      const html = await res.text();
      const hits = parseHtmlResults(html);
      if (!hits.length && (res.status === 202 || /anomaly|captcha|challenge/i.test(html))) return "Error: the search engine asked for a human check, so the search could not run. Try again later, or ask the user to set NAVVIED_SEARCH_URL to a search server.";
      return format(query, hits.slice(0, limit));
    } catch (e) { return `Error: ${e instanceof Error ? e.message : String(e)}`; }
  },
};
