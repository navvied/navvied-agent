/**
 * The relay side of being asked by agents on the web: an outside agent reaches this computer at `<site>/a2a/<handle>/`, the relay forwards
 * the JSON-RPC body (and sends back the reply, a stream included) over the connection this computer already holds, and each end checks the
 * token. The shapes below are proposals until the server sends its exact frames; they are data only, so only this file changes then.
 * The relay sees the messages while they pass and does not keep them.
 */
import type { A2aServer } from "./a2a-server.ts";

/** Tells the relay that a token (by its hash, never the token) may be used at this handle. */
export const registerFrame = (handle: string, tokenHash: string): { ev: "a2a.register"; handle: string; tokenHash: string } => ({ ev: "a2a.register", handle, tokenHash });
/** Tells the relay that a token no longer works. */
export const revokeFrame = (tokenHash: string): { ev: "a2a.revoke"; tokenHash: string } => ({ ev: "a2a.revoke", tokenHash });
/** Where an outside agent finds this computer. */
export const relayAddress = (site: string, handle: string): string => `${site.replace(/\/+$/, "")}/a2a/${handle}/`;

/** What the relay hands over for one request: the method, the path below the handle, the headers it received, the body, and the address it came from. */
export interface Forwarded { method: string; path: string; headers: Record<string, string>; body?: string; address: string }

/** The headers of a browser, and of the relay's own hop, are not passed on: a request through the relay is judged as a direct one from a program. */
const DROPPED = new Set(["host", "origin", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "cookie", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "forwarded"]);

/** Answers a forwarded request with the same server, the same checks and the same limits as a direct one. The reply is returned as it is, so a stream can be passed on as it is written. */
export function answerForwarded(server: Pick<A2aServer, "handle">, f: Forwarded): Promise<Response> {
  const headers = new Headers();
  for (const [k, v] of Object.entries(f.headers)) if (!DROPPED.has(k.toLowerCase())) headers.set(k, v);
  const path = f.path.startsWith("/") ? f.path : `/${f.path}`;
  return server.handle(new Request(`http://localhost${path}`, { method: f.method, headers, ...(f.method === "GET" || f.method === "HEAD" || f.body === undefined ? {} : { body: f.body }) }), f.address);
}
