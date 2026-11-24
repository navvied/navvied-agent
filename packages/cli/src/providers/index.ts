import { accountsScreen } from "./accounts.ts";
import { keysScreen } from "./keys.ts";
import { endpointsScreen } from "./endpoints.ts";
import { localScreen } from "./local.ts";
import type { Kit, Result } from "./kit.ts";

const PARTS = [
  { label: "Accounts", run: accountsScreen },
  { label: "API keys", run: keysScreen },
  { label: "Custom Endpoints", run: endpointsScreen },
  { label: "Local Models", run: localScreen },
] as const;

/** Providers: the three ways to bring a model of one's own: a key for a service, a server of one's own, or a model that runs on this computer. */
export async function providersScreen(k: Kit): Promise<Result> {
  if (!k.io.choose) { k.say("Providers need a terminal. Run navvied in a terminal and type /providers."); return "back"; }
  let at = 0;
  for (;;) {
    const picked = await k.choose("Providers", "Providers", PARTS.map((p) => ({ label: p.label })), { at });
    if (picked === undefined) return "back";
    at = picked;
    if ((await PARTS[picked]!.run(k)) === "switched") return "switched";
  }
}
