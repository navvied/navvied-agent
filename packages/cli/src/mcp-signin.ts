import { mcpSignIn, type OAuthStore } from "@navvied/engine";
import type { Command, EngineEvent } from "@navvied/protocol";
import type { McpEntry } from "./config.ts";

export interface McpSigninDeps {
  /** Whether this session is Navvied Cloud: nothing is signed in there, a computer's browser is not reachable. */
  inCloud(): boolean;
  /** Tells every window. A window opens the address of a `waiting` event in a browser. */
  tell(e: EngineEvent): void;
  /** The connected programs of the configuration file, now. */
  servers(): Record<string, McpEntry>;
  store: OAuthStore;
  /** How long to wait for the person (a test makes it short). */
  waitMs?: number;
}

const REFUSED = "A connected program is signed in to only on a computer, never in Navvied Cloud.";

/** What the commands `mcp.signin` and `mcp.signin.cancel` do: one sign-in at a time per program, said in events. */
export function mcpSignin(d: McpSigninDeps): { command(cmd: Command): boolean } {
  const running = new Map<string, AbortController>();
  const tell = (server: string, state: "waiting" | "done" | "failed" | "stopped", more: { url?: string; reason?: string } = {}): void => { d.tell({ ev: "mcp.signin", server, state, ...more }); };

  const start = async (server: string): Promise<void> => {
    const entry = d.servers()[server];
    if (!entry?.url) { tell(server, "failed", { reason: entry ? "That program runs on this computer: it has no sign-in." : "That program is not in the configuration." }); return; }
    if (running.has(server)) return;
    const stop = new AbortController();
    running.set(server, stop);
    try {
      await mcpSignIn({ url: entry.url, store: d.store, ...(entry.oauth ? { client: entry.oauth } : {}), signal: stop.signal, ...(d.waitMs ? { waitMs: d.waitMs } : {}), open: (address) => { tell(server, "waiting", { url: address }); } });
      tell(server, "done");
    } catch (e) {
      if (stop.signal.aborted) tell(server, "stopped");
      else tell(server, "failed", { reason: e instanceof Error ? e.message.replace(/^./, (c) => c.toUpperCase()) : String(e) });
    } finally { running.delete(server); }
  };

  return {
    command(cmd) {
      if (cmd.cmd !== "mcp.signin" && cmd.cmd !== "mcp.signin.cancel") return false;
      if (d.inCloud()) { d.tell({ ev: "error", msg: REFUSED }); return true; }
      if (cmd.cmd === "mcp.signin") void start(cmd.server); else running.get(cmd.server)?.abort();
      return true;
    },
  };
}
