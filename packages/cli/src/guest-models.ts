import { existsSync, statSync } from "node:fs";
import { DEFAULT_SERVER, readAccount, writeHostedModels } from "./account.ts";
import { fetchGuestModels } from "./account-client.ts";
import { accountPath, configPath, guestModelsPath, loadConfig } from "./config.ts";
import type { Options } from "./args.ts";
import type { IO } from "./io.ts";

const DAY_MS = 86_400_000;

/**
 * A computer that is not signed in may use the free models of navvied.com. Which ones is asked of the server (one small request, with a
 * short wait) when this program starts for a conversation, and kept for a day. Nothing is asked when the person is signed in (the account
 * has its own list), turned this off (`"guestModels": false` or `NAVVIED_GUEST_MODELS=0`), chose a model by environment variables, or runs inside a sandbox.
 */
export async function ensureGuestModels(io: IO, options: Options): Promise<void> {
  if (options.sandboxed || io.env.NAVVIED_BASE_URL || io.env.NAVVIED_MODEL || io.env.NAVVIED_GUEST_MODELS === "0") return;
  if (readAccount(accountPath(io.env, options.config))) return;
  const file = loadConfig(configPath(io.env, options.config));
  if (file.ok && file.value?.guestModels === false) return;
  const cache = guestModelsPath(io.env);
  try { if (existsSync(cache) && Date.now() - statSync(cache).mtimeMs < DAY_MS) return; } catch { /* asked again */ }
  try { writeHostedModels(cache, await fetchGuestModels(io.fetch, DEFAULT_SERVER, AbortSignal.timeout(3000))); } catch { /* offline, or a server that has none: the next start asks again */ }
}
