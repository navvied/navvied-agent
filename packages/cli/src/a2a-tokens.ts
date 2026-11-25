import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { PEER_NAME } from "./a2a-config.ts";

/** An agent that may call this computer. Only the hash of its token is kept: the token is shown once, when it is made. */
export interface PeerToken { name: string; hash: string; /** What the agent may do: ask, and nothing else. */ scope: "ask"; createdAt: number; lastUsed?: number }

const PREFIX = "navvied-a2a-";
export const hashOf = (token: string): string => createHash("sha256").update(token).digest("hex");
const same = (a: string, b: string): boolean => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
const valid = (t: unknown): t is PeerToken => { const x = t as PeerToken; return typeof x === "object" && x !== null && typeof x.name === "string" && typeof x.hash === "string" && /^[0-9a-f]{64}$/.test(x.hash) && typeof x.createdAt === "number" && x.scope === "ask"; };

/**
 * The tokens of the agents allowed to call this computer, in a private file. One token per agent, and the name of the token is who the
 * agent is: nothing a request says about itself is believed. The file is read again whenever it changes, so a token revoked by another
 * program (`navvied a2a revoke`) stops working in a server that is already running.
 */
export class PeerTokens {
  #list: PeerToken[] = [];
  #handle: string | undefined;
  #stamp = "";
  constructor(private readonly path: string, private readonly now: () => number = Date.now) {}

  #load(): void {
    let stamp = "";
    try { const st = statSync(this.path); stamp = `${st.mtimeMs}:${st.size}`; } catch { this.#list = []; this.#stamp = ""; return; }
    if (stamp === this.#stamp) return;
    this.#stamp = stamp;
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as { peers?: unknown; handle?: unknown };
      this.#handle = typeof raw.handle === "string" && /^[0-9a-f]{32}$/.test(raw.handle) ? raw.handle : undefined;
      this.#list = Array.isArray(raw.peers) ? raw.peers.filter(valid) : [];
    } catch { this.#list = []; }
  }

  #save(): void {
    const dir = dirname(this.path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify({ ...(this.#handle ? { handle: this.#handle } : {}), peers: this.#list }, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, this.path);
    try { chmodSync(this.path, 0o600); } catch { /* not supported on this system */ }
    try { const st = statSync(this.path); this.#stamp = `${st.mtimeMs}:${st.size}`; } catch { this.#stamp = ""; }
  }

  list(): readonly PeerToken[] { this.#load(); return this.#list; }

  /** The random 128-bit name of this computer's address on the relay, made the first time A2A is turned on and kept in this private file. It is never made from an account or an e-mail address. */
  handle(): string {
    this.#load();
    if (!this.#handle) { this.#handle = randomBytes(16).toString("hex"); this.#save(); }
    return this.#handle;
  }

  /** Makes the token for a new agent name and returns it: this is the only time it can be read. */
  add(name: string): { ok: true; token: string; hash: string } | { ok: false; error: string } {
    if (!PEER_NAME.test(name)) return { ok: false, error: `"${name}" is not a name: use letters, digits, dots, dashes or underscores (at most 32)` };
    this.#load();
    if (this.#list.some((t) => t.name === name)) return { ok: false, error: `"${name}" has a token already. Revoke it first to make a new one.` };
    const token = `${PREFIX}${randomBytes(24).toString("base64url")}`;
    const hash = hashOf(token);
    this.#list.push({ name, hash, scope: "ask", createdAt: this.now() });
    this.#save();
    return { ok: true, token, hash };
  }

  /** The hash of the token that was revoked (the relay is told it), or nothing when there was none by that name. */
  revoke(name: string): string | undefined {
    this.#load();
    const gone = this.#list.find((t) => t.name === name);
    if (!gone) return undefined;
    this.#list = this.#list.filter((t) => t !== gone);
    this.#save();
    return gone.hash;
  }

  /** The name this token belongs to, or nothing. Every stored hash is compared, so the time taken does not say which one was near. */
  who(token: string): string | undefined {
    this.#load();
    if (!token.startsWith(PREFIX)) return undefined;
    const hash = hashOf(token);
    let found: PeerToken | undefined;
    for (const t of this.#list) if (same(t.hash, hash)) found = t;
    if (!found) return undefined;
    // Not written on every call: a busy peer would rewrite the file for each request.
    if (!found.lastUsed || this.now() - found.lastUsed > 60_000) { found.lastUsed = this.now(); try { this.#save(); } catch { /* the stamp is a convenience */ } }
    return found.name;
  }
}
