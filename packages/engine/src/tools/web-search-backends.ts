import { USER_AGENT } from "./user-agent.ts";
import { whyUnreached, type Unreached } from "./web-errors.ts";
import { parseJsonResults, type Backend, type Outcome, type SearchHit } from "./web-search-hits.ts";
import { RING } from "./web-search-ring.ts";

export { parseJsonResults, type Backend, type Outcome, type SearchHit };

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

/** Results from the lighter page of the same engine. */
export function parseLiteResults(html: string): SearchHit[] {
  const hits: SearchHit[] = [];
  const link = /<a[^>]*href=["']([^"']+)["'][^>]*class=["']result-link["'][^>]*>([\s\S]*?)<\/a>|<a[^>]*class=["']result-link["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/g;
  for (let m = link.exec(html); m; m = link.exec(html)) {
    const next = html.indexOf("result-link", m.index + m[0].length);
    const section = html.slice(m.index, next < 0 ? undefined : next);
    const snippet = /class=["']result-snippet["'][^>]*>([\s\S]*?)<\/td>/.exec(section)?.[1] ?? "";
    const url = target(m[1] ?? m[3]!);
    if (/^https?:\/\//.test(url)) hits.push({ title: text(m[2] ?? m[4]!), url, snippet: text(snippet) });
  }
  return hits;
}

/** Results of the encyclopedia's own search API (`action=query&list=search`). */
export function parseWikipediaResults(body: unknown, origin = "https://en.wikipedia.org"): SearchHit[] {
  const list = (body as { query?: { search?: unknown } } | null)?.query?.search;
  if (!Array.isArray(list)) return [];
  return list.flatMap((r: unknown) => {
    const hit = (typeof r === "object" && r !== null ? r : {}) as Record<string, unknown>;
    return typeof hit.title === "string" ? [{ title: hit.title, url: `${origin}/wiki/${encodeURIComponent(hit.title.replace(/ /g, "_")).replace(/%2F/g, "/").replace(/%3A/g, ":")}`, snippet: typeof hit.snippet === "string" ? text(hit.snippet) : "" }] : [];
  });
}

/** A search engine's own page, as opposed to what a network puts in its place: the engine says its name in the title of every answer, results or none. */
const isDuckDuckGo = (html: string): boolean => /<title>[^<]*DuckDuckGo/i.test(html);
const asksForHuman = (status: number, html: string): boolean => status === 202 || /anomaly|captcha|challenge/i.test(html);

/** Asks one address and says what came of it: the answer, or why there is none (a certificate that is not the site's own, a network that does not connect, a status). */
async function fetched(url: string, signal: AbortSignal, accept?: string): Promise<{ status: number; body: string } | { failed: Unreached }> {
  try {
    const res = await fetch(url, { signal, headers: { "user-agent": USER_AGENT, ...(accept ? { accept } : {}) } });
    return { status: res.status, body: await res.text() };
  } catch (e) { return { failed: whyUnreached(e) }; }
}

const duckduckgo = (id: string, label: string, url: (q: string) => string, parse: (html: string) => SearchHit[]): Backend => ({
  id, label,
  async ask(query, _limit, signal) {
    const got = await fetched(url(query), signal);
    if ("failed" in got) return got;
    if (got.status !== 200 && got.status !== 202) return { failed: "status", status: got.status };
    const hits = parse(got.body);
    if (hits.length) return { hits };
    if (asksForHuman(got.status, got.body)) return { human: true };
    return isDuckDuckGo(got.body) ? { hits: [] } : { failed: "blocked" };
  },
});

/** Where navvied's own search is, and the account token of this computer when it is signed in (a computer that is not is a guest there). */
export interface NavviedSearch { server: string; token?: string }

/** Search through the navvied service, which asks the public search pages from an address that is not blocked: the way for a computer whose network blocks them. */
function navvied(where: () => NavviedSearch | undefined): Backend {
  return {
    id: "navvied", label: "navvied search",
    async ask(query, limit, signal) {
      const at = where();
      if (!at) return { failed: "network" };
      try {
        const res = await fetch(`${at.server.replace(/\/+$/, "")}/api/search?q=${encodeURIComponent(query)}&max=${limit}`, { signal, headers: { accept: "application/json", "user-agent": USER_AGENT, ...(at.token ? { authorization: `Bearer ${at.token}` } : {}) } });
        const body = (await res.json().catch(() => undefined)) as { results?: unknown; error?: { message?: unknown } } | undefined;
        if (res.status === 200) return Array.isArray(body?.results) ? { hits: parseJsonResults({ results: (body!.results as Record<string, unknown>[]).map((r) => ({ ...r, content: r.snippet })) }) } : { failed: "blocked" };
        return { failed: "status", status: res.status, ...(typeof body?.error?.message === "string" ? { said: body.error.message } : {}) };
      } catch (e) { return { failed: whyUnreached(e) }; }
    },
  };
}

const BASE: readonly Backend[] = [
  duckduckgo("duckduckgo", "DuckDuckGo", (q) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, parseHtmlResults),
  duckduckgo("duckduckgo-lite", "DuckDuckGo", (q) => `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}`, parseLiteResults),
  {
    // The only other site that lets a program ask without a key and without breaking its own rules (robots.txt and terms): a search of the encyclopedia, not of the whole web.
    id: "wikipedia", label: "Wikipedia",
    async ask(query, limit, signal) {
      const got = await fetched(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=${limit}&format=json&utf8=1`, signal, "application/json");
      if ("failed" in got) return got;
      if (got.status !== 200) return { failed: "status", status: got.status };
      try { return { hits: parseWikipediaResults(JSON.parse(got.body)) }; } catch { return { failed: "blocked" }; }
    },
  },
];

const REST: readonly string[] = ["duckduckgo", "duckduckgo-lite", "navvied", "wikipedia"];

/** Where the ring starts: random for each program, one further for each search, so no one service takes all the questions of a person or of a fleet. */
let turn = Math.floor(Math.random() * RING.length);
const nextTurn = (): number => turn++ % RING.length;
const turned = (start: number): string[] => [...RING.slice(start), ...RING.slice(0, start)].map((b) => b.id);

/** Every backend there is, with navvied's own search reached the way `via` says. */
export const backends = (via?: () => NavviedSearch | undefined): Backend[] => [...RING, ...BASE, navvied(via ?? (() => undefined))];

/**
 * The backends in the order asked for (unknown names are ignored). An empty or unusable list is the default: the ring (from `start`, or the next turn), then the public pages,
 * navvied's own search and the encyclopedia. A list that names backends is followed exactly, with no turning.
 */
export function inOrder(order: readonly string[] | undefined, via?: () => NavviedSearch | undefined, start?: number): Backend[] {
  const all = backends(via);
  const pick = (names: readonly string[]): Backend[] => [...new Set(names.flatMap((id) => all.filter((b) => b.id === id)))];
  const chosen = pick(order ?? []);
  return chosen.length ? chosen : pick([...turned(start ?? nextTurn()), ...REST]);
}
