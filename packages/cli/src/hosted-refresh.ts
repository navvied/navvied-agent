import { readHostedModels, writeHostedModels, type Account, type HostedModels } from "./account.ts";
import { AccountError, fetchModels } from "./account-client.ts";

export type Refreshed = { changed: boolean; signedOut?: string };

/**
 * The server's list of hosted models is the one source: it is asked of the server, and kept on this computer only so that an offline start still has a list.
 * Nothing is written when the list is the same, and a server that cannot be reached leaves what was known.
 */
export async function refreshHosted(send: typeof fetch, account: Account, file: string, limitMs?: number): Promise<Refreshed> {
  let listing: HostedModels;
  try { listing = await fetchModels(send, account, limitMs ? AbortSignal.timeout(limitMs) : undefined); }
  catch (e) { return e instanceof AccountError && e.message.startsWith("You were signed out") ? { changed: false, signedOut: e.message } : { changed: false }; }
  const known = readHostedModels(file);
  if (known && JSON.stringify(known) === JSON.stringify(listing)) return { changed: false };
  writeHostedModels(file, listing);
  return { changed: true };
}
