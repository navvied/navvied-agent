import { readFileSync } from "node:fs";
import { askPeer, type PeerBook, type PeerTarget } from "@navvied/engine";
import type { A2aPeer } from "./a2a-config.ts";
import type { Env } from "./config.ts";

const DEFAULT_SECONDS = 120;

/** The token of a peer, read when it is needed: from the environment variable or the file the configuration names. Never from the configuration itself. */
export function tokenOf(peer: A2aPeer, env: Env): string | undefined {
  if (peer.tokenEnv) return env[peer.tokenEnv]?.trim() || undefined;
  if (peer.tokenFile) { try { return readFileSync(peer.tokenFile, "utf8").trim() || undefined; } catch { return undefined; } }
  return undefined;
}

/** The agents the person set up, as the engine's tool asks them. */
export function peerBook(peers: Record<string, A2aPeer>, env: Env, fetcher: typeof fetch, sleep?: (ms: number) => Promise<void>): PeerBook {
  return {
    names: Object.keys(peers),
    ask(name, message, context, signal) {
      const peer = peers[name];
      if (!peer) return Promise.reject(new Error(`there is no agent "${name}"`));
      const target: PeerTarget = { name, url: peer.url, token: () => tokenOf(peer, env), timeoutMs: (peer.timeoutSeconds ?? DEFAULT_SECONDS) * 1000 };
      return askPeer(target, message, context, { fetch: fetcher, signal, ...(sleep ? { sleep } : {}) });
    },
  };
}
