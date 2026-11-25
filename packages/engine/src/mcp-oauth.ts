/**
 * Sign-in for connected programs reached over the web (OAuth 2.1 authorization code with PKCE). The host opens the browser and shows the screen;
 * this module finds the server's sign-in addresses, registers navvied with it when it allows that, waits for the browser to come back to a
 * loopback address of this computer, trades the code for tokens, keeps them (file mode 0600) and renews them when they run out.
 * A token is never printed, logged or put in an error.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname } from "node:path";

/** What a person may say about the server's sign-in when it cannot register navvied by itself. */
export interface OAuthClient { clientId?: string; clientSecret?: string; scope?: string }

interface Saved { access: string; refresh?: string; /** In ms since the epoch. */ expires?: number; clientId: string; clientSecret?: string; tokenEndpoint: string }

const STEP_MS = 15_000;
const SIGNIN_MS = 5 * 60_000;
const SOON_MS = 60_000;

/** The tokens of every server, by the server's address, in one file that only this user can read. */
export class OAuthStore {
  constructor(private readonly file: string) {}

  #all(): Record<string, Saved> {
    try { const v = JSON.parse(readFileSync(this.file, "utf8")) as unknown; return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, Saved>) : {}; } catch { return {}; }
  }

  get(url: string): Saved | undefined { return this.#all()[url]; }

  set(url: string, saved: Saved | undefined): void {
    const all = this.#all();
    if (saved) all[url] = saved; else delete all[url];
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    writeFileSync(`${this.file}.new`, JSON.stringify(all), { mode: 0o600 });
    renameSync(`${this.file}.new`, this.file);
  }
}

export class OAuthError extends Error {}

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");
const isLoopback = (u: URL): boolean => u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]";

/** An address from the server's own answer, accepted only when a token can travel over it safely. */
function safe(address: unknown, what: string): string {
  let u: URL;
  try { u = new URL(String(address)); } catch { throw new OAuthError(`the server gave a ${what} that is not an address`); }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && isLoopback(u))) throw new OAuthError(`the server's ${what} is not secure (it must start with https://)`);
  return u.toString();
}

async function getJson(url: string, signal: AbortSignal): Promise<Record<string, unknown> | undefined> {
  try {
    const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.any([signal, AbortSignal.timeout(STEP_MS)]) });
    if (!res.ok) return undefined;
    const v = (await res.json()) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
  } catch { return undefined; }
}

export interface Endpoints { authorize: string; token: string; register?: string }

/** Where to sign in: the server names it (`WWW-Authenticate`, then the well-known documents), and a server that names nothing gets the usual paths on its own address. */
export async function discover(serverUrl: string, challenge: string | null | undefined, signal: AbortSignal): Promise<Endpoints> {
  const server = new URL(serverUrl);
  const path = server.pathname.replace(/\/$/, "");
  const named = challenge?.match(/resource_metadata="([^"]+)"/)?.[1];
  const resource = (named ? await getJson(safe(named, "resource address"), signal) : undefined)
    ?? (path ? await getJson(`${server.origin}/.well-known/oauth-protected-resource${path}`, signal) : undefined)
    ?? await getJson(`${server.origin}/.well-known/oauth-protected-resource`, signal);
  const first = Array.isArray(resource?.authorization_servers) ? resource.authorization_servers[0] : undefined;
  const issuer = new URL(typeof first === "string" ? safe(first, "sign-in server") : server.origin);
  const base = issuer.pathname.replace(/\/$/, "");
  const meta = await getJson(`${issuer.origin}/.well-known/oauth-authorization-server${base}`, signal)
    ?? await getJson(`${issuer.origin}/.well-known/openid-configuration${base}`, signal)
    ?? await getJson(`${issuer.origin}${base}/.well-known/openid-configuration`, signal);
  if (meta) {
    if (Array.isArray(meta.code_challenge_methods_supported) && !meta.code_challenge_methods_supported.includes("S256")) throw new OAuthError("the server's sign-in does not support the safe code exchange (S256)");
    return { authorize: safe(meta.authorization_endpoint, "sign-in address"), token: safe(meta.token_endpoint, "token address"), ...(meta.registration_endpoint ? { register: safe(meta.registration_endpoint, "registration address") } : {}) };
  }
  return { authorize: safe(`${issuer.origin}/authorize`, "sign-in address"), token: safe(`${issuer.origin}/token`, "token address"), register: safe(`${issuer.origin}/register`, "registration address") };
}

/** What the token address said, in words: the server's own `error` and `error_description`, never a token. */
async function tokenCall(endpoint: string, form: Record<string, string>, signal: AbortSignal): Promise<{ access: string; refresh?: string; expires?: number }> {
  let res: Response;
  try { res = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: new URLSearchParams(form), signal: AbortSignal.any([signal, AbortSignal.timeout(STEP_MS)]) }); }
  catch { throw new OAuthError("the server's token address could not be reached"); }
  const body = (await res.json().catch(() => undefined)) as Record<string, unknown> | undefined;
  if (!res.ok || typeof body?.access_token !== "string") {
    const why = typeof body?.error_description === "string" ? body.error_description : typeof body?.error === "string" ? body.error : `status ${res.status}`;
    throw new OAuthError(`the server refused the sign-in: ${why.slice(0, 200)}`);
  }
  if (typeof body.token_type === "string" && body.token_type.toLowerCase() !== "bearer") throw new OAuthError("the server gave a kind of token that is not supported");
  return { access: body.access_token, ...(typeof body.refresh_token === "string" ? { refresh: body.refresh_token } : {}), ...(typeof body.expires_in === "number" ? { expires: Date.now() + body.expires_in * 1000 } : {}) };
}

/** The browser comes back here with the answer. Only this computer can reach the address, and only a request that carries the right `state` counts. */
async function loopback(state: string): Promise<{ redirect: string; code(signal: AbortSignal, ms: number): Promise<string>; close(): void }> {
  let settle!: { ok(code: string): void; fail(e: Error): void };
  const answer = new Promise<string>((ok, fail) => { settle = { ok, fail }; });
  answer.catch(() => undefined);
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://127.0.0.1");
    if (u.pathname !== "/callback" || u.searchParams.get("state") !== state) { res.writeHead(400).end(); return; }
    const error = u.searchParams.get("error"), code = u.searchParams.get("code");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(`<!doctype html><meta charset="utf-8"><title>navvied</title><p>${error || !code ? "The sign-in did not finish. You can close this tab." : "Signed in. You can close this tab."}</p>`);
    if (error) settle.fail(new OAuthError(`the server stopped the sign-in: ${(u.searchParams.get("error_description") ?? error).slice(0, 200)}`));
    else if (code) settle.ok(code);
  });
  await new Promise<void>((ok, fail) => { server.once("error", fail); server.listen(0, "127.0.0.1", ok); });
  const port = (server.address() as { port: number }).port;
  return {
    redirect: `http://127.0.0.1:${port}/callback`,
    code: (signal, ms) => new Promise<string>((ok, fail) => {
      const timer = setTimeout(() => fail(new OAuthError("the sign-in was not finished in time")), ms);
      const stop = (): void => { clearTimeout(timer); fail(new OAuthError("the sign-in was stopped")); };
      signal.addEventListener("abort", stop, { once: true });
      if (signal.aborted) stop();
      answer.then((c) => { clearTimeout(timer); signal.removeEventListener("abort", stop); ok(c); }, (e: Error) => { clearTimeout(timer); signal.removeEventListener("abort", stop); fail(e); });
    }),
    close: () => { server.close(); server.closeAllConnections(); },
  };
}

export interface SignIn {
  url: string;
  store: OAuthStore;
  /** The `WWW-Authenticate` header of the answer that asked for it, when there was one. */
  challenge?: string | null;
  client?: OAuthClient;
  /** Opens the sign-in page: the host's job (a browser on this computer, or an address shown to the person). */
  open(address: string): void | Promise<void>;
  signal?: AbortSignal;
  /** How long to wait for the person (a test makes it short). */
  waitMs?: number;
}

/** Signs in to one server. Resolves when the tokens are kept; rejects with the reason in words. */
export async function signIn(o: SignIn): Promise<void> {
  const signal = o.signal ?? new AbortController().signal;
  const found = await discover(o.url, o.challenge, signal);
  const state = b64(randomBytes(16));
  const back = await loopback(state);
  try {
    let clientId = o.client?.clientId, clientSecret = o.client?.clientSecret;
    if (!clientId) {
      if (!found.register) throw new OAuthError("the server does not register new programs by itself: ask it for a client id and put it in the entry as oauth.clientId");
      const res = await fetch(found.register, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ client_name: "navvied", redirect_uris: [back.redirect], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none", application_type: "native" }), signal: AbortSignal.any([signal, AbortSignal.timeout(STEP_MS)]) }).catch(() => undefined);
      const reg = res?.ok ? ((await res.json().catch(() => undefined)) as Record<string, unknown> | undefined) : undefined;
      if (typeof reg?.client_id !== "string") throw new OAuthError("the server did not accept navvied as a new program: ask it for a client id and put it in the entry as oauth.clientId");
      clientId = reg.client_id;
      if (typeof reg.client_secret === "string") clientSecret = reg.client_secret;
    }
    const verifier = b64(randomBytes(32));
    const page = new URL(found.authorize);
    for (const [k, v] of Object.entries({ response_type: "code", client_id: clientId, redirect_uri: back.redirect, state, code_challenge: b64(createHash("sha256").update(verifier).digest()), code_challenge_method: "S256", resource: o.url, ...(o.client?.scope ? { scope: o.client.scope } : {}) })) page.searchParams.set(k, v);
    await o.open(page.toString());
    const code = await back.code(signal, o.waitMs ?? SIGNIN_MS);
    const got = await tokenCall(found.token, { grant_type: "authorization_code", code, redirect_uri: back.redirect, client_id: clientId, code_verifier: verifier, resource: o.url, ...(clientSecret ? { client_secret: clientSecret } : {}) }, signal);
    o.store.set(o.url, { ...got, clientId, ...(clientSecret ? { clientSecret } : {}), tokenEndpoint: found.token });
  } finally { back.close(); }
}

/** What a request to one server carries: the kept token, renewed when it is about to run out. */
export class OAuthSession {
  #renewing: Promise<boolean> | undefined;

  constructor(readonly url: string, private readonly store: OAuthStore) {}

  get signedIn(): boolean { return this.store.get(this.url) !== undefined; }

  async header(): Promise<string | undefined> {
    let s = this.store.get(this.url);
    if (s?.expires && s.expires - Date.now() < SOON_MS && s.refresh) { await this.renew(); s = this.store.get(this.url); }
    return s ? `Bearer ${s.access}` : undefined;
  }

  /** Asks for a new token with the one kept for that. False when there is none or the server will not give one: the person signs in again. */
  renew(): Promise<boolean> {
    this.#renewing ??= this.#renew().finally(() => { this.#renewing = undefined; });
    return this.#renewing;
  }

  async #renew(): Promise<boolean> {
    const s = this.store.get(this.url);
    if (!s?.refresh) return false;
    try {
      const got = await tokenCall(s.tokenEndpoint, { grant_type: "refresh_token", refresh_token: s.refresh, client_id: s.clientId, resource: this.url, ...(s.clientSecret ? { client_secret: s.clientSecret } : {}) }, AbortSignal.timeout(STEP_MS));
      this.store.set(this.url, { ...s, ...got, refresh: got.refresh ?? s.refresh });
      return true;
    } catch (e) {
      // A server that says the token is no good ends it; one that could not be reached keeps it for the next try.
      if (e instanceof OAuthError && e.message.startsWith("the server refused")) this.store.set(this.url, undefined);
      return false;
    }
  }
}
