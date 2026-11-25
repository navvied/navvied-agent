import type { Unreached } from "./web-errors.ts";

export interface SearchHit { title: string; url: string; snippet: string }

/** What one search site made of a question: results (possibly none, when the site is plainly working), a request for a human, or why it was not usable. */
export type Outcome = { hits: SearchHit[] } | { human: true } | { failed: Unreached | "blocked" | "status"; status?: number; /** What the server itself said, when it said it in a sentence. */ said?: string };

export interface Backend {
  id: string;
  /** How a person or model names it: "DuckDuckGo". */
  label: string;
  ask(query: string, limit: number, signal: AbortSignal): Promise<Outcome>;
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
