import type { Tool, ToolContext } from "../types.ts";
import { clip, num, str } from "./util.ts";
import { fixSearchArgs } from "./web-names.ts";
import { inOrder, parseJsonResults, type Backend, type Outcome, type SearchHit } from "./web-search-backends.ts";
import { USER_AGENT } from "./user-agent.ts";
import { untrusted } from "./untrusted.ts";
import { searches } from "./web-search-cache.ts";
import { unreachedSentence, whyUnreached } from "./web-errors.ts";
import { viaProxy } from "./web-proxy.ts";

export { parseHtmlResults, parseJsonResults, parseLiteResults, parseWikipediaResults, type SearchHit } from "./web-search-backends.ts";

const short = (s: string): string => { const one = s.replace(/\s+/g, " ").trim(); return one.length > 200 ? `${one.slice(0, 199).trimEnd()}…` : one; };

const format = (query: string, hits: SearchHit[]): string =>
  hits.length ? untrusted("search", clip(`Results for "${query}":\n\n${hits.map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}${h.snippet ? `\n   ${short(h.snippet)}` : ""}`).join("\n\n")}`)) : `No results for "${query}". Try other words: ${JSON.stringify({ query: `${query.split(/\s+/).slice(0, 3).join(" ")} documentation` })}`;

const SERVER = "who can set NAVVIED_SEARCH_URL to a search server that answers in JSON";
const HUMAN_CHECK = `Error: the search engine asked for a human check, so the search could not run. Do not search again; say so to the user, ${SERVER}.`;

/** Why one rung of the ladder gave nothing, in a sentence. */
function said(b: Backend, o: Exclude<Outcome, { hits: SearchHit[] }>): string {
  if ("human" in o) return `${b.label} asked for a human check.`;
  if (o.failed === "blocked") return `${b.label} answered with a page that is not its own, which usually means the network blocks it.`;
  if (o.failed === "status") return o.status === 401 ? `${b.label} did not accept this computer's sign-in. Sign in again.` : o.said ? `${b.label}: ${o.said}` : o.status === 429 ? `${b.label} is limiting its free searches for now.` : `${b.label} answered ${o.status}.`;
  return unreachedSentence(o.failed, b.label);
}

/** The whole ladder gets this long, however many sites are slow: a person is not kept waiting for eight of them. */
const LADDER_MS = 30_000;

/**
 * The keyless ladder: the ring of search services (see web-search-ring.ts), then each public search site in turn, until one answers. A site that cannot be reached (a network that blocks it, with a certificate that is not its own), that answers
 * with a page that is not its own, or that asks for a human, hands over to the next one; a site that works and finds nothing is an answer. A bad certificate is never accepted.
 */
async function ladder(query: string, limit: number, search: ToolContext["search"], ctx: { signal: AbortSignal }): Promise<string> {
  const failures: string[] = [];
  let human = false, first: Backend | undefined;
  const all = AbortSignal.any([ctx.signal, AbortSignal.timeout(LADDER_MS)]);
  for (const backend of inOrder(search?.order, search?.navvied)) {
    if (all.aborted) break;
    const got = await backend.ask(query, limit, AbortSignal.any([all, AbortSignal.timeout(10_000)]));
    if ("hits" in got) {
      if (got.hits.length) return `${first && first.label !== backend.label ? `Note: ${failures[0]} These results are from ${backend.label}.\n\n` : ""}${format(query, got.hits.slice(0, limit))}`;
      if (!failures.length) return format(query, []);
      continue;
    }
    first ??= backend;
    if ("human" in got) human = true;
    failures.push(said(backend, got));
  }
  return human ? HUMAN_CHECK : `Error: ${failures[0] ?? "the search was stopped."} Do not search again; say so to the user, ${SERVER}.`;
}

export const webSearch: Tool = {
  name: "WebSearch",
  readOnly: true,
  offeredWhen: ({ userText, chat }) => chat === true || /\b(search|internet|online|on the web|latest|news|price|look up|google)\b/i.test(userText),
  description: "Search the web: links and summaries.",
  parameters: { type: "object", properties: { query: { type: "string" }, max_results: { type: "number" } }, required: ["query"] },
  fixArgs: fixSearchArgs,
  title: (a) => `Search the web for ${str(a.query)}`,
  async run(a, ctx) {
    const query = str(a.query).trim();
    if (!query) return `Error: the query is empty. Retry: WebSearch ${JSON.stringify({ query: "words to look for" })}`;
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
        const res = await fetch(`${configured}${configured.includes("?") ? "&" : "?"}q=${encodeURIComponent(query)}&format=json`, { signal, headers: { accept: "application/json", "user-agent": USER_AGENT } });
        if (!res.ok) return `Error: the search server answered ${res.status}.`;
        return format(query, parseJsonResults(await res.json()).slice(0, limit));
      }
      return await searches.get(`${ctx.search?.order?.join(",") ?? ""}|${limit}|${query.toLowerCase()}`, () => ladder(query, limit, ctx.search, ctx), (text) => !/^(Error|No results)/.test(text));
    } catch (e) {
      const why = whyUnreached(e);
      return `Error: ${why === "network" ? (e instanceof Error ? e.message : String(e)) : unreachedSentence(why, "The search server")}`;
    }
  },
};
