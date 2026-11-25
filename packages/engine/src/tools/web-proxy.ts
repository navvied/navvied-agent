import type { WebProxy } from "../types.ts";

/** What the service answered: its JSON when it said yes, or its own sentence when it said no (it checks addresses, size and rate itself). */
export type ProxyAnswer<T> = { ok: true; value: T } | { ok: false; message: string };

/** Asks a service of a session that has no network of its own, with the session's token; `what` names the service in the sentence a failure gives. */
export async function askService<T>(url: string, token: string, body: object, signal: AbortSignal, what = "web service"): Promise<ProxyAnswer<T>> {
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", signal, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch { return { ok: false, message: `the ${what} of this session could not be reached.` }; }
  const answer: unknown = await res.json().catch(() => undefined);
  if (res.ok) return answer && typeof answer === "object" ? { ok: true, value: answer as T } : { ok: false, message: `the ${what} gave an answer that could not be read.` };
  const said = (answer as { error?: { message?: unknown } } | undefined)?.error?.message;
  return { ok: false, message: typeof said === "string" && said ? said : `the ${what} answered ${res.status}.` };
}

/** Asks the web service of a session that has no network of its own (`path` is `fetch` or `search`). */
export const viaProxy = <T>(proxy: WebProxy, path: "fetch" | "search", body: object, signal: AbortSignal): Promise<ProxyAnswer<T>> => askService<T>(`${proxy.url.replace(/\/+$/, "")}/${path}`, proxy.token, body, signal);
