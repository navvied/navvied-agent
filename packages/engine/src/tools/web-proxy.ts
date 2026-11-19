import type { WebProxy } from "../types.ts";

/** What the service answered: its JSON when it said yes, or its own sentence when it said no (it checks addresses, size and rate itself). */
export type ProxyAnswer<T> = { ok: true; value: T } | { ok: false; message: string };

/** Asks the web service of a session that has no network of its own (`path` is `fetch` or `search`). */
export async function viaProxy<T>(proxy: WebProxy, path: "fetch" | "search", body: object, signal: AbortSignal): Promise<ProxyAnswer<T>> {
  let res: Response;
  try {
    res = await fetch(`${proxy.url.replace(/\/+$/, "")}/${path}`, { method: "POST", signal, headers: { authorization: `Bearer ${proxy.token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch { return { ok: false, message: "the web service of this session could not be reached." }; }
  const answer: unknown = await res.json().catch(() => undefined);
  if (res.ok) return answer && typeof answer === "object" ? { ok: true, value: answer as T } : { ok: false, message: "the web service gave an answer that could not be read." };
  const said = (answer as { error?: { message?: unknown } } | undefined)?.error?.message;
  return { ok: false, message: typeof said === "string" && said ? said : `the web service answered ${res.status}.` };
}
