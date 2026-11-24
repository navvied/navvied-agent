import type { Account } from "./account.ts";

/**
 * The page of navvied.com, shown by the app or by this computer's own page, asks the same paths of its own origin that it asks of the site. The hub answers them
 * here: the account's token is added on this side and never reaches the page, and only the paths and methods below go anywhere (anything else is not found).
 * The server decides who may do what (an admin's paths answer only for an admin); nothing here gives any power of its own.
 */
const ID = "[A-Za-z0-9_-]{1,80}";
const ALLOWED: { methods: readonly string[]; path: RegExp; open?: boolean }[] = [
  { methods: ["GET"], path: /^\/api\/account\/providers$/, open: true },
  { methods: ["GET"], path: /^\/api\/account\/me$/ },
  { methods: ["GET"], path: /^\/api\/hosted\/status$/, open: true },
  { methods: ["GET"], path: /^\/api\/hosted\/session\/alive$/ },
  { methods: ["GET"], path: /^\/api\/account\/computers$/ },
  { methods: ["PATCH", "DELETE"], path: new RegExp(`^/api/account/computers/${ID}$`) },
  { methods: ["GET"], path: /^\/api\/account\/conversations$/ },
  { methods: ["GET", "PATCH", "DELETE"], path: new RegExp(`^/api/account/conversations/${ID}$`) },
  { methods: ["POST"], path: new RegExp(`^/api/account/conversations/${ID}/fork$`) },
  { methods: ["GET"], path: /^\/api\/admin\/(hosted|audit)$/ },
  { methods: ["PUT"], path: new RegExp(`^/api/admin/(models|groups)/${ID}$`) },
  { methods: ["PUT"], path: /^\/api\/admin\/(cloud|limits)$/ },
  { methods: ["POST"], path: new RegExp(`^/api/admin/groups/${ID}/test$`) },
];

const MAX_BODY = 1024 * 1024;
const MAX_QUERY = 300;
/** The only headers of the page that go on: what is sent and what is wanted. Cookies, the page's own token and its origin stay here. */
const FROM_PAGE = ["content-type", "accept"] as const;
/** The only headers of the server's answer that go back. */
const TO_PAGE = ["content-type", "content-disposition", "retry-after"] as const;

export interface SiteProxyDeps {
  fetch: typeof fetch;
  account: () => Account | undefined;
  /** Where the open paths go when nobody is signed in. */
  site: string;
  inCloud: () => boolean;
  /** The id this computer has among the account's computers, once it has joined them. */
  here?: () => string | undefined;
}

const say = (body: unknown, status: number): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

/** The server's list of computers, as it is, with the one that is this computer marked `here`. */
function marked(body: unknown, here: string | undefined): unknown {
  const list = (body as { computers?: unknown } | undefined)?.computers;
  if (!here || !Array.isArray(list)) return body;
  return { ...(body as object), computers: list.map((c) => (c && typeof c === "object" && (c as { id?: unknown }).id === here ? { ...c, here: true } : c)) };
}

/** Whether the proxy answers this path at all (a method that is not allowed on it is answered here, too). */
export const isSitePath = (pathname: string): boolean => ALLOWED.some((a) => a.path.test(pathname));

/**
 * The answer to one request of the page, for a request the caller has already let in (the page's own token, its origin). `undefined` when the path is not the proxy's.
 */
export async function siteProxy(deps: SiteProxyDeps, req: Request, url: URL): Promise<Response | undefined> {
  if (!isSitePath(url.pathname)) return undefined;
  if (deps.inCloud()) return say({ error: "Not found." }, 404);
  const account = deps.account();
  // Nobody is signed in: there is no one to ask the server about.
  if (url.pathname === "/api/account/me" && !account && req.method === "GET") return say({ user: null }, 200);
  const rule = ALLOWED.find((a) => a.path.test(url.pathname))!;
  if (!rule.methods.includes(req.method)) return say({ error: "Method not allowed." }, 405);
  if (url.search.length > MAX_QUERY) return say({ error: "Bad request." }, 400);
  if (!account && !rule.open) return say({ error: "Not signed in." }, 401);
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY) return say({ error: "Too large." }, 413);
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
  if (body && body.byteLength > MAX_BODY) return say({ error: "Too large." }, 413);
  const server = account?.server ?? deps.site;
  const headers: Record<string, string> = {};
  for (const h of FROM_PAGE) { const v = req.headers.get(h); if (v) headers[h] = v; }
  if (account) { headers.authorization = `Bearer ${account.token}`; headers.origin = new URL(server).origin; }
  try {
    const res = await deps.fetch(`${server.replace(/\/+$/, "")}${url.pathname}${url.search}`, { method: req.method, headers, ...(body ? { body } : {}), redirect: "manual", signal: AbortSignal.timeout(15_000) });
    const out: Record<string, string> = { "cache-control": "no-store" };
    for (const h of TO_PAGE) { const v = res.headers.get(h); if (v) out[h] = v; }
    if (url.pathname === "/api/account/computers" && req.method === "GET" && res.ok) return say(marked(await res.json().catch(() => undefined), deps.here?.()), res.status);
    return new Response(res.status === 204 || res.status === 304 ? null : res.body, { status: res.status >= 300 && res.status < 400 ? 502 : res.status, headers: out });
  } catch { return say({ error: "The server could not be reached." }, 502); }
}

export const SESSION_PATH = "/api/hosted/session";

/** The conversation a page asks to join in the cloud, and whether it takes the session over: nothing else of its query goes to the server. */
export function sessionQuery(url: URL): string | undefined {
  const conversation = url.searchParams.get("conversation");
  if (conversation !== null && !new RegExp(`^${ID}$`).test(conversation)) return undefined;
  const params = new URLSearchParams();
  if (conversation) params.set("conversation", conversation);
  if (url.searchParams.get("takeover") === "1") params.set("takeover", "1");
  const text = params.toString();
  return text ? `?${text}` : "";
}

export interface Tunnel {
  /** What the page said. */
  message(data: string | Buffer): void;
  /** The page is gone. */
  close(): void;
}

export interface TunnelDeps {
  account: () => Account | undefined;
  inCloud: () => boolean;
}

/** Whether the page may open the cloud session at all, and the address it goes to: the account's token is added when the connection is made, and never leaves this computer except to the server. */
export function sessionTarget(deps: TunnelDeps, url: URL): { ok: true; target: string; headers: Record<string, string> } | { ok: false; status: number; error: string } {
  if (deps.inCloud()) return { ok: false, status: 404, error: "Not found." };
  const account = deps.account();
  if (!account) return { ok: false, status: 401, error: "Not signed in." };
  const query = sessionQuery(url);
  if (query === undefined) return { ok: false, status: 400, error: "Bad request." };
  const server = new URL(account.server);
  const wire = `${server.protocol === "https:" ? "wss:" : "ws:"}//${server.host}${server.pathname.replace(/\/+$/, "")}${SESSION_PATH}${query}`;
  return { ok: true, target: wire, headers: { authorization: `Bearer ${account.token}`, origin: server.origin } };
}

export const RELAY_PATH = "/relay/ws";

/**
 * The page speaks the relay's protocol itself, end to end with another computer's pairing secret, so this computer only passes the frames on: no account token goes with
 * them. The relay lets a page in by the site it says it is from, so that is the origin the connection is made with.
 */
export function relayTarget(deps: { inCloud: () => boolean; relayUrl: () => string; site: string }): { ok: true; target: string; headers: Record<string, string> } | { ok: false; status: number; error: string } {
  if (deps.inCloud()) return { ok: false, status: 404, error: "Not found." };
  return { ok: true, target: deps.relayUrl(), headers: { origin: new URL(deps.site).origin } };
}

/** Joins the page's socket to the server's: every message goes both ways as it is, and when either side ends the other does too. */
export function tunnel(target: { target: string; headers: Record<string, string> }, page: { send(data: string | Buffer): void; close(code?: number, reason?: string): void }): Tunnel {
  const upstream = new WebSocket(target.target, { headers: target.headers } as never);
  const waiting: (string | Buffer)[] = [];
  let ended = false;
  upstream.onopen = () => { for (const m of waiting.splice(0)) upstream.send(m); };
  upstream.onmessage = (m) => { if (!ended) page.send(typeof m.data === "string" ? m.data : Buffer.from(m.data as ArrayBuffer)); };
  upstream.onclose = (e) => { if (!ended) { ended = true; page.close(e.code === 1005 || e.code === 1006 ? 1011 : e.code, e.reason); } };
  upstream.onerror = () => { if (!ended) { ended = true; page.close(1011, "The server could not be reached."); } };
  return {
    message(data) { if (upstream.readyState === WebSocket.OPEN) upstream.send(data); else if (upstream.readyState === WebSocket.CONNECTING) waiting.push(data); },
    close() { ended = true; try { upstream.close(); } catch { /* already closed */ } },
  };
}
