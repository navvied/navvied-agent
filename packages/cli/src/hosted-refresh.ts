import { existsSync } from "node:fs";
import { readAccount, readHostedModels, writeHostedModels, type Account, type HostedModels } from "./account.ts";
import { accountPath, hostedModelsPath } from "./config.ts";
import type { Options } from "./args.ts";
import type { IO } from "./io.ts";
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

/** A computer that is signed in but has never listed the models (just updated, or the list was deleted) asks for them before its model is chosen, so a hosted model can be named at once. */
export async function ensureHostedModels(io: IO, options: Options): Promise<void> {
  const account = readAccount(accountPath(io.env, options.config));
  if (account && !existsSync(hostedModelsPath(io.env))) await refreshHosted(io.fetch, account, hostedModelsPath(io.env), 3000);
}
