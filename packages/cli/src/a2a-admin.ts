import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { A2aPeerInfo, A2aTokenInfo, EngineEvent, Result } from "@navvied/protocol";
import { PEER_NAME, type A2aPeer } from "./a2a-config.ts";
import { TOKEN_SYNC_MS } from "./a2a-relay.ts";
import { PeerTokens } from "./a2a-tokens.ts";
import { a2aPeerTokenPath, a2aTokensPath, loadConfig, saveA2a, type Env } from "./config.ts";

/** Where the settings of agent-to-agent calls are kept: the configuration file (the agents this computer asks) and the private file of tokens (the agents that ask it). */
export interface A2aPlaces { env: Env; config: string }

/** What `navvied a2a add` and the page's `a2a.token.add` both do: make the token of an agent. It can be read only in this answer. */
export function addToken(tokens: PeerTokens, name: string): Result<{ token: string }> {
  const made = tokens.add(name);
  return made.ok ? { ok: true, value: { token: made.token } } : made;
}

/** What `navvied a2a revoke` and `a2a.token.revoke` both do. The relay hears of it within `TOKEN_SYNC_MS`. */
export function revokeToken(tokens: PeerTokens, name: string): Result<null> {
  return tokens.revoke(name) === undefined ? { ok: false, error: `no agent is called "${name}"` } : { ok: true, value: null };
}

const peerInfo = (name: string, p: A2aPeer): A2aPeerInfo => ({ name, url: p.url, token: p.tokenEnv !== undefined || p.tokenFile !== undefined, ...(p.timeoutSeconds ? { timeoutSeconds: p.timeoutSeconds } : {}) });
const tokenInfo = (t: { name: string; createdAt: number; lastUsed?: number }): A2aTokenInfo => ({ name: t.name, createdAt: t.createdAt, ...(t.lastUsed ? { lastUsed: t.lastUsed } : {}) });

/** The agents this computer may ask and the ones that may ask it. Never a token, a hash, the name of an environment variable or the path of a file. */
export function a2aList(places: A2aPlaces): Extract<EngineEvent, { ev: "a2a" }> {
  const file = loadConfig(places.config, places.env);
  const peers = file.ok ? Object.entries(file.value?.a2a?.peers ?? {}).map(([name, p]) => peerInfo(name, p)) : [];
  return { ev: "a2a", peers, tokens: new PeerTokens(a2aTokensPath(places.env)).list().map(tokenInfo), syncSeconds: TOKEN_SYNC_MS / 1000 };
}

/** Keeps a token the person was given for an agent, in a private file of its own (never in the configuration file). */
function keepToken(path: string, token: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${token}\n`, { mode: 0o600 });
  renameSync(temp, path);
  try { chmodSync(path, 0o600); } catch { /* not supported on this system */ }
}

export interface PeerForm { name: string; url: string; token?: string; tokenEnv?: string; tokenFile?: string; timeoutSeconds?: number }

/** Adds (or changes) an agent this computer may ask. A given `token` goes to a private file; the configuration names that file. A name that is there keeps its token when none is given. */
export function addPeer(places: A2aPlaces, form: PeerForm): Result<null> {
  if (!PEER_NAME.test(form.name)) return { ok: false, error: `"${form.name}" is not a name: use letters, digits, dots, dashes or underscores (at most 32)` };
  const own = a2aPeerTokenPath(places.env, form.name);
  try { if (form.token) keepToken(own, form.token); } catch (e) { return { ok: false, error: `the token could not be kept: ${e instanceof Error ? e.message : String(e)}` }; }
  const saved = saveA2a(places.config, (a2a) => {
    const was = a2a.peers[form.name];
    const next: A2aPeer = { url: form.url, ...(form.timeoutSeconds ? { timeoutSeconds: form.timeoutSeconds } : {}) };
    if (form.token) next.tokenFile = own;
    else if (form.tokenEnv) next.tokenEnv = form.tokenEnv;
    else if (form.tokenFile) next.tokenFile = form.tokenFile;
    else { if (was?.tokenEnv) next.tokenEnv = was.tokenEnv; if (was?.tokenFile) next.tokenFile = was.tokenFile; }
    a2a.peers[form.name] = next;
  });
  return saved.ok ? { ok: true, value: null } : saved;
}

/** Stops asking an agent; the token file this computer made for it goes too (one the person named is theirs and stays). */
export function removePeer(places: A2aPlaces, name: string): Result<null> {
  const file = loadConfig(places.config, places.env);
  if (!file.ok) return file;
  if (!file.value?.a2a?.peers[name]) return { ok: false, error: `no agent is called "${name}"` };
  const saved = saveA2a(places.config, (a2a) => { delete a2a.peers[name]; });
  if (!saved.ok) return saved;
  const own = a2aPeerTokenPath(places.env, name);
  if (file.value.a2a.peers[name]!.tokenFile === own && existsSync(own)) rmSync(own, { force: true });
  return { ok: true, value: null };
}
