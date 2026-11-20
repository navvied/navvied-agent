import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { isPrivateHost } from "./hosts.ts";

/** What the web tools reach the network with, so a test can stand in for it. */
export const web = {
  fetch: (input: URL, init: RequestInit): Promise<Response> => fetch(input, init),
  addresses: async (host: string): Promise<string[]> => (await lookup(host, { all: true })).map((a) => a.address),
};

/**
 * Why a page may not be fetched, or nothing. The name is not enough: it is looked up, and every address it has must be public. A name
 * that does not resolve is refused, never let through. Run for the first address and again for every hop of a redirect. (The fetch
 * itself looks the name up again; a name that changes its answer between the two is not caught here.)
 */
export async function refusal(url: URL, allowPrivate: boolean): Promise<string | undefined> {
  if (url.protocol !== "http:" && url.protocol !== "https:") return "only http(s) addresses can be fetched.";
  if (allowPrivate) return undefined;
  if (isPrivateHost(url.hostname)) return "fetching local or private network addresses is not allowed.";
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) return undefined;
  let found: string[];
  try { found = await web.addresses(host); } catch { return `the name ${host} could not be looked up, so it was not fetched.`; }
  if (!found.length) return `the name ${host} could not be looked up, so it was not fetched.`;
  if (found.some((a) => isPrivateHost(a))) return `${host} points to a local or private network address, so it was not fetched.`;
  return undefined;
}
