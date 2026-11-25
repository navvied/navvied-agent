import { USER_AGENT } from "./user-agent.ts";
import { whyUnreached } from "./web-errors.ts";
import { parseJsonResults, type Backend, type Outcome, type SearchHit } from "./web-search-hits.ts";

/**
 * The keyless ring: four search services that say in their own documentation that a program may ask without a key (a free tier with its own limits). The service, not this
 * computer, makes the search, so only the service's own address has to be reachable. Each is asked with the program's honest name; a key is never sent.
 */

interface Reply { status: number; body: string }

async function post(url: string, headers: Record<string, string>, body: object, signal: AbortSignal): Promise<Reply | { failed: "tls" | "timeout" | "network" }> {
  try {
    const res = await fetch(url, { method: "POST", signal, headers: { "content-type": "application/json", "user-agent": USER_AGENT, ...headers }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.text() };
  } catch (e) { return { failed: whyUnreached(e) }; }
}

/** A vendor's own sentence about why it said no, on one line and short, or nothing. */
const sentence = (s: unknown): string | undefined => (typeof s === "string" && s.trim() ? s.replace(/\s+/g, " ").trim().slice(0, 120) : undefined);
const LIMITED = /rate.?limit|too many requests|\b429\b|quota|slow down/i;
const limited = (said: string | undefined): Outcome | undefined => (said && LIMITED.test(said) ? { failed: "status", status: 429 } : undefined);

/** What the vendor's answer is, as a failure when it is not a good one. */
function refused(r: Reply): Outcome | undefined {
  if (r.status < 400) return undefined;
  const said = (() => { try { const j = JSON.parse(r.body) as { error?: unknown; detail?: unknown; message?: unknown }; return sentence(typeof j.error === "string" ? j.error : (j.error as { message?: unknown } | undefined)?.message ?? j.detail ?? j.message); } catch { return undefined; } })();
  return r.status === 429 ? { failed: "status", status: 429 } : { failed: "status", status: r.status, ...(said ? { said } : {}) };
}

/** The text of the first item of an MCP answer, which comes as plain JSON or as server-sent events; a vendor's error (a limit among them) becomes a failure. */
export function mcpText(body: string): { text: string } | Outcome {
  const frames = [body.trim(), ...body.split(/\r\n|\r|\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5))];
  for (const frame of frames) {
    let m: { error?: { message?: unknown }; result?: { isError?: boolean; content?: { text?: unknown }[] } };
    try { m = JSON.parse(frame); } catch { continue; }
    const said = sentence(m.error?.message ?? (m.result?.isError ? m.result.content?.[0]?.text : undefined));
    if (m.error || m.result?.isError) return limited(said) ?? { failed: "status", status: 502, ...(said ? { said } : {}) };
    const text = m.result?.content?.find((c) => typeof c.text === "string")?.text;
    if (typeof text === "string") return { text };
  }
  return { failed: "blocked" };
}

/** Exa answers with blocks of `Title:`, `URL:`, `Highlights:` lines, one block between `---` lines. */
export function parseExaResults(text: string): SearchHit[] {
  return text.split(/\n---\n/).flatMap((block) => {
    const field = (name: string): string => new RegExp(`^${name}:[ \\t]*(.*)$`, "m").exec(block)?.[1]?.trim() ?? "";
    const url = field("URL");
    return /^https?:\/\//.test(url) ? [{ title: field("Title") || url, url, snippet: /^Highlights:[ \t]*\n?([\s\S]*)$/m.exec(block)?.[1]?.trim() ?? "" }] : [];
  });
}

/** Parallel answers with JSON in the text: `results` with `excerpts`. */
export function parseParallelResults(text: string): SearchHit[] {
  try { return parseJsonResults({ results: ((JSON.parse(text) as { results?: { excerpts?: unknown }[] }).results ?? []).map((r) => ({ ...r, content: Array.isArray(r.excerpts) ? r.excerpts.join(" ") : "" })) }); } catch { return []; }
}

/** Keenable and Tavily answer with JSON: `results` with a `snippet` (Keenable) or `content` (Tavily). */
export function parseListedResults(body: string): SearchHit[] {
  try { return parseJsonResults({ results: ((JSON.parse(body) as { results?: { snippet?: unknown; description?: unknown; content?: unknown }[] }).results ?? []).map((r) => ({ ...r, content: r.snippet || r.description || r.content })) }); } catch { return []; }
}

function vendor(id: string, label: string, call: (query: string, limit: number, signal: AbortSignal) => Promise<Reply | { failed: "tls" | "timeout" | "network" }>, read: (body: string) => SearchHit[] | Outcome): Backend {
  return {
    id, label,
    async ask(query, limit, signal) {
      const got = await call(query, limit, signal);
      if ("failed" in got) return got;
      const no = refused(got);
      if (no) return no;
      const out = read(got.body);
      return Array.isArray(out) ? { hits: out } : out;
    },
  };
}

const MCP = { accept: "application/json, text/event-stream" };
const rpc = (tool: string, args: object): object => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } });
const viaText = (parse: (text: string) => SearchHit[]) => (body: string): SearchHit[] | Outcome => { const got = mcpText(body); return "text" in got ? parse(got.text) : got; };

/** Parallel limits the free tier by a number it is given and never sees again: one per program run. */
const SESSION = crypto.randomUUID();

export const RING: readonly Backend[] = [
  vendor("exa", "Exa", (q, n, s) => post("https://mcp.exa.ai/mcp", MCP, rpc("web_search_exa", { query: q, numResults: n }), s), viaText(parseExaResults)),
  vendor("parallel", "Parallel", (q, _n, s) => post("https://search.parallel.ai/mcp", MCP, rpc("web_search", { objective: q, search_queries: [q], session_id: SESSION }), s), viaText(parseParallelResults)),
  vendor("keenable", "Keenable", (q, n, s) => post("https://api.keenable.ai/v1/search/public", { "x-keenable-title": "navvied" }, { query: q, max_results: n }, s), parseListedResults),
  vendor("tavily", "Tavily", (q, n, s) => post("https://api.tavily.com/search", { "x-tavily-access-mode": "keyless", "x-client-name": "navvied" }, { query: q, max_results: n, include_raw_content: false, include_images: false }, s), parseListedResults),
];
