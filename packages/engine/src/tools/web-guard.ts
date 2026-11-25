import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { redact } from "../redact.ts";
import { isPrivateHost } from "./hosts.ts";
import { whyUnreached } from "./web-errors.ts";

/**
 * Asks the addresses one after the other, each as the address itself with the name in the `host` header and in the certificate check (the name is what is verified, so a
 * certificate that is not the site's own is still refused). The runtime never looks the name up again, so a name that changes its answer between the check and the visit
 * (DNS rebinding) reaches nothing the check did not allow. A network that does not connect moves on to the next address; any other failure is the answer.
 */
async function pinned(url: URL, init: RequestInit, addresses: readonly string[]): Promise<Response> {
  let last: unknown;
  for (const address of addresses.slice(0, 4)) {
    const at = new URL(url);
    at.hostname = address.includes(":") ? `[${address}]` : address;
    const headers = new Headers(init.headers);
    headers.set("host", url.host);
    try { return await fetch(at, { ...init, headers, ...(url.protocol === "https:" ? { tls: { serverName: url.hostname } } : {}) } as RequestInit); }
    catch (e) { last = e; if (whyUnreached(e) !== "network") throw e; }
  }
  throw last;
}

/** What the web tools reach the network with, so a test can stand in for it. `pin` are the addresses the guard found public: they, and no other, are connected to. */
export const web = {
  fetch: (input: URL, init: RequestInit, pin: readonly string[] = []): Promise<Response> => (pin.length ? pinned(input, init, pin) : fetch(input, init)),
  addresses: async (host: string): Promise<string[]> => (await lookup(host, { all: true })).map((a) => a.address),
};

/** A request that goes through a proxy is connected by the proxy, which has its own rules: it cannot be pinned. */
const proxied = (url: URL): boolean => (url.protocol === "https:" ? ["HTTPS_PROXY", "https_proxy"] : ["HTTP_PROXY", "http_proxy"]).concat(["ALL_PROXY", "all_proxy"]).some((n) => process.env[n]);

/** A key or a token in an address ends up in the logs of every server and proxy on the way, and in the hands of a page that was told to send it. */
function carriesSecret(url: URL): boolean {
  const parts = [url.search, `${url.username}:${url.password}`];
  return parts.some((p) => { let plain = p; try { plain = decodeURIComponent(p); } catch { /* read as written */ } return redact(p) !== p || redact(plain) !== plain; });
}

export type Vetted = { refused: string } | { pin: string[] };

/**
 * Whether a page may be fetched, and if so which addresses to connect to. The name is not enough: it is looked up, and every address it has must be public. A name
 * that does not resolve is refused, never let through. Run for the first address and again for every hop of a redirect.
 */
export async function vet(url: URL, allowPrivate: boolean): Promise<Vetted> {
  if (url.protocol !== "http:" && url.protocol !== "https:") return { refused: "only http(s) addresses can be fetched." };
  if (carriesSecret(url)) return { refused: "the address carries what looks like a key or a token, and secrets do not belong in addresses; it was not fetched." };
  if (allowPrivate) return { pin: [] };
  if (isPrivateHost(url.hostname)) return { refused: "fetching local or private network addresses is not allowed." };
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) return { pin: [] };
  let found: string[];
  try { found = await web.addresses(host); } catch { return { refused: `the name ${host} could not be looked up, so it was not fetched.` }; }
  if (!found.length) return { refused: `the name ${host} could not be looked up, so it was not fetched.` };
  if (found.some((a) => isPrivateHost(a))) return { refused: `${host} points to a local or private network address, so it was not fetched.` };
  return { pin: proxied(url) ? [] : found };
}

/** Why a page may not be fetched, or nothing. */
export async function refusal(url: URL, allowPrivate: boolean): Promise<string | undefined> {
  const v = await vet(url, allowPrivate);
  return "refused" in v ? v.refused : undefined;
}
