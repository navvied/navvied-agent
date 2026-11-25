/**
 * The computer's side of being asked by agents on the web: an outside agent reaches this computer at `<site>/a2a/<handle>/`, the relay
 * hands the request over the connection this computer already holds (its signed-in channel) and passes the answer back, a stream
 * included. The relay checks the token first, so a stranger never wakes a computer; each request is judged here again, by the same server
 * and the same limits as a direct one. The frames are the relay's own (`A2aFrame` in `packages/relay/src/a2a.ts`, written out below
 * because this package does not depend on the relay; a test keeps the two together). The relay sees the messages while they pass and
 * keeps nothing.
 */
import type { A2aServer } from "./a2a-server.ts";

/** What this computer sends the relay. */
export type ToRelay =
  | { t: "a2a.register"; handle: string; tokenHash: string }
  | { t: "a2a.revoke"; tokenHash: string }
  | { t: "a2a.off"; handle: string }
  | { t: "a2a.head"; id: string; status: number; headers?: Record<string, string> }
  | { t: "a2a.chunk"; id: string; text: string }
  | { t: "a2a.end"; id: string };

/** What the relay hands this computer. `headers` are already reduced to authorization, content-type, accept, last-event-id, a2a-version and a2a-extensions. */
export type FromRelay =
  | { t: "a2a.req"; id: string; method: string; path: string; headers: Record<string, string>; body?: string; address: string }
  | { t: "a2a.cancel"; id: string };

/** The name a token has on the relay: `base64url(SHA-256(token))`. The token file keeps the same hash in hex. */
export const relayHash = (hex: string): string => Buffer.from(hex, "hex").toString("base64url");
/** Where an outside agent finds this computer. */
export const relayAddress = (site: string, handle: string): string => `${site.replace(/\/+$/, "")}/a2a/${handle}/`;

/** What the relay hands over for one request: the method, the path below the handle, the headers it received, the body, and the address it came from. */
export interface Forwarded { method: string; path: string; headers: Record<string, string>; body?: string; address: string }

/** The headers of a browser, and of the relay's own hop, are not passed on: a request through the relay is judged as a direct one from a program. */
const DROPPED = new Set(["host", "origin", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "cookie", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "forwarded"]);

/** Answers a forwarded request with the same server, the same checks and the same limits as a direct one. The reply is returned as it is, so a stream can be passed on as it is written. */
export function answerForwarded(server: Pick<A2aServer, "handle">, f: Forwarded, signal?: AbortSignal): Promise<Response> {
  const headers = new Headers();
  for (const [k, v] of Object.entries(f.headers)) if (!DROPPED.has(k.toLowerCase())) headers.set(k, v);
  const path = f.path.startsWith("/") ? f.path : `/${f.path}`;
  return server.handle(new Request(`http://localhost${path}`, { method: f.method, headers, ...(signal ? { signal } : {}), ...(f.method === "GET" || f.method === "HEAD" || f.body === undefined ? {} : { body: f.body }) }), f.address);
}

export interface A2aRelayOptions {
  /** This computer's name on the relay: the random handle in the token file. */
  handle: string;
  /** The same server a direct request reaches. */
  server: Pick<A2aServer, "handle">;
  /** The tokens that may ask, by the hash the token file keeps (hex). Read again on every `sync`. */
  hashes: () => readonly string[];
  /** A stream is written to the relay in batches: after this long (default 50 ms) or this many characters (default 4096), whichever comes first. The connection allows 200 frames a second. */
  flushMs?: number;
  flushChars?: number;
  /** How often the token file is looked at again, so `navvied a2a add|revoke` in another program reaches the relay (default `TOKEN_SYNC_MS`; 0 never). */
  syncMs?: number;
}

/** How often the token file is looked at again (milliseconds), so a token made or revoked by another program reaches the relay within this time. */
export const TOKEN_SYNC_MS = 2000;

const BAD = (v: unknown): boolean => typeof v !== "string" || v.length === 0 || v.length > 200;

/**
 * Connects the A2A server to the relay frames. It does not hold a connection itself: the computer's signed-in channel (`RelayHost`) calls
 * `connected` whenever that connection is ready (every reconnect: the relay forgets a handle when its engine leaves), `message` with each
 * `a2a.*` frame it receives and `disconnected` when the connection goes.
 */
export class A2aRelay {
  readonly #o: A2aRelayOptions;
  #send: ((frame: object) => void) | undefined;
  #told = new Set<string>();
  readonly #open = new Map<string, AbortController>();
  #timer: ReturnType<typeof setInterval> | undefined;
  #off = false;

  constructor(options: A2aRelayOptions) { this.#o = options; }

  /** The channel is ready: say again which tokens may be used at the handle. */
  connected(send: (frame: object) => void): void {
    this.#send = send;
    this.#told.clear();
    this.#off = false;
    this.sync();
    if (!this.#timer && (this.#o.syncMs ?? TOKEN_SYNC_MS) > 0) { this.#timer = setInterval(() => this.sync(), this.#o.syncMs ?? TOKEN_SYNC_MS); (this.#timer as { unref?: () => void }).unref?.(); }
  }

  /** The channel went (only if it is still the one that was told): what was being answered stops, and the next `connected` registers again. */
  disconnected(send: (frame: object) => void): void {
    if (this.#send !== send) return;
    this.#send = undefined;
    this.#told.clear();
    for (const ctl of this.#open.values()) ctl.abort();
    this.#open.clear();
  }

  /** Tells the relay the tokens that were added or revoked since it was last told. */
  sync(): void {
    if (!this.#send || this.#off) return;
    const now = new Set(this.#o.hashes().map(relayHash));
    for (const hash of this.#told) if (!now.has(hash)) { this.#told.delete(hash); this.#put({ t: "a2a.revoke", tokenHash: hash }); }
    for (const hash of now) if (!this.#told.has(hash)) { this.#told.add(hash); this.#put({ t: "a2a.register", handle: this.#o.handle, tokenHash: hash }); }
  }

  /** A2A is turned off or the server stops: the handle stops answering at the relay, and what is being answered is stopped. Connecting again turns it on again. */
  stop(): void {
    clearInterval(this.#timer);
    this.#timer = undefined;
    if (this.#send && !this.#off) this.#put({ t: "a2a.off", handle: this.#o.handle });
    this.#off = true;
    this.#told.clear();
    for (const ctl of this.#open.values()) ctl.abort();
    this.#open.clear();
  }

  #put(frame: ToRelay): void { try { this.#send?.(frame); } catch { /* the channel is gone; the close is handled by its owner */ } }

  /** A frame from the relay. Anything that is not one of the two it may send is ignored. */
  message(msg: Record<string, unknown>): void {
    if (this.#off) return;
    if (msg.t === "a2a.cancel" && typeof msg.id === "string") { this.#open.get(msg.id)?.abort(); this.#open.delete(msg.id); return; }
    if (msg.t !== "a2a.req" || BAD(msg.id) || BAD(msg.method) || typeof msg.path !== "string" || typeof msg.address !== "string") return;
    const headers: Record<string, string> = {};
    if (typeof msg.headers === "object" && msg.headers !== null) for (const [k, v] of Object.entries(msg.headers)) if (typeof v === "string") headers[k] = v;
    const id = msg.id as string;
    if (this.#open.has(id)) return;
    const ctl = new AbortController();
    this.#open.set(id, ctl);
    void this.#answer(id, ctl, { method: msg.method as string, path: msg.path, headers, ...(typeof msg.body === "string" ? { body: msg.body } : {}), address: msg.address });
  }

  async #answer(id: string, ctl: AbortController, f: Forwarded): Promise<void> {
    const flushMs = this.#o.flushMs ?? 50, flushChars = this.#o.flushChars ?? 4096;
    const live = (): boolean => !ctl.signal.aborted && this.#open.get(id) === ctl;
    let pending = "", timer: ReturnType<typeof setTimeout> | undefined;
    /** Sends what is held, in frames of at most `flushChars` characters (never splitting a pair of UTF-16 halves). */
    const flush = (): void => {
      clearTimeout(timer); timer = undefined;
      while (pending && live()) {
        let n = Math.min(pending.length, flushChars);
        const last = pending.charCodeAt(n - 1);
        if (n < pending.length && last >= 0xd800 && last <= 0xdbff) n++;
        this.#put({ t: "a2a.chunk", id, text: pending.slice(0, n) });
        pending = pending.slice(n);
      }
    };
    try {
      let res: Response;
      try { res = await answerForwarded(this.#o.server, f, ctl.signal); }
      catch { res = new Response(JSON.stringify({ error: { message: "This agent could not answer." } }), { status: 502, headers: { "content-type": "application/json" } }); }
      if (!live()) return;
      const type = res.headers.get("content-type");
      this.#put({ t: "a2a.head", id, status: res.status, headers: { ...(type ? { "content-type": type } : {}), ...(type?.startsWith("text/event-stream") ? { "x-accel-buffering": "no" } : {}) } });
      if (res.body) {
        const reader = res.body.getReader(), decoder = new TextDecoder();
        const onAbort = (): void => { void reader.cancel().catch(() => undefined); };
        ctl.signal.addEventListener("abort", onAbort, { once: true });
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done || !live()) break;
            pending += decoder.decode(value, { stream: true });
            if (pending.length >= flushChars) flush();
            else if (pending && !timer) timer = setTimeout(flush, flushMs);
          }
          pending += decoder.decode();
        } catch { /* the stream broke: what was written is passed on, then the end */ }
        finally { ctl.signal.removeEventListener("abort", onAbort); }
      }
      flush();
      if (live()) this.#put({ t: "a2a.end", id });
    } finally {
      clearTimeout(timer);
      if (this.#open.get(id) === ctl) this.#open.delete(id);
    }
  }
}
