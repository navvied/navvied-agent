/** The ways models write the arguments of the two web tools, made into the arguments the tools have. */

const first = (a: Record<string, unknown>, names: string[]): unknown => names.map((n) => a[n]).find((v) => v !== undefined && v !== "");

export function fixFetchArgs(a: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a };
  let url = first(a, ["url", "link", "uri", "href", "page", "address", "urls", "links"]);
  const rest: string[] = [];
  if (Array.isArray(url)) { const all = url.filter((u): u is string => typeof u === "string"); url = all[0]; rest.push(...all.slice(1)); }
  if (typeof url === "string") {
    url = url.trim();
    if (url && !/^[a-z][a-z0-9+.-]*:/i.test(url as string)) url = `https://${url as string}`;
  }
  if (url !== undefined) out.url = url;
  if (rest.length) out.also = rest;
  const offset = first(a, ["offset", "start_index", "start_from_char", "start"]);
  if (offset !== undefined) out.offset = typeof offset === "string" ? Number(offset) || 0 : offset;
  return out;
}

export function fixSearchArgs(a: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a };
  let query = first(a, ["query", "q", "search_query", "search", "text", "keywords", "term"]);
  // `{"search_query": [{"q": "…"}]}`: a list of searches; the first is run.
  if (Array.isArray(query)) { const one = query[0] as unknown; query = typeof one === "string" ? one : (one as { q?: unknown; query?: unknown } | undefined)?.q ?? (one as { query?: unknown } | undefined)?.query; }
  if (Array.isArray(a.queries)) query = typeof a.queries[0] === "string" ? a.queries[0] : query;
  if (typeof query === "string") out.query = query;
  const limit = first(a, ["max_results", "limit", "n", "count", "num_results", "top_k"]);
  if (limit !== undefined) out.max_results = typeof limit === "string" ? Number(limit) || 5 : limit;
  return out;
}

/** The names models call the web tools by. */
export const WEB_ALIASES: Record<string, string> = {
  web_search: "WebSearch", websearch: "WebSearch", search: "WebSearch", google: "WebSearch", search_web: "WebSearch", internet_search: "WebSearch",
  web_fetch: "WebFetch", webfetch: "WebFetch", fetch: "WebFetch", open_url: "WebFetch", browse: "WebFetch", read_url: "WebFetch", fetch_url: "WebFetch", get_url: "WebFetch", read_page: "WebFetch", open_page: "WebFetch",
};
