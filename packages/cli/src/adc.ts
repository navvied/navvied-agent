import { createSign } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { Credentials } from "@navvied/engine";

/** Where the access token comes from: a credential file that stays where it is (only its path is kept), the service that exchanges it, and what the token may do. */
export interface AdcSpec { file: string; tokenUri: string; scope: string }

type Env = Record<string, string | undefined>;

/** How an entry of the catalogue says where the credential file is looked for, in the order of the provider's own documentation. */
export interface AdcPlaces { env: string; wellKnown: { posix: string; windows: string }; tokenUri: string; scope: string }

/** The credential file of this computer: the one the environment names, else the well-known place; or why there is none. */
export function findCredentialFile(places: AdcPlaces, env: Env, platform: NodeJS.Platform = process.platform, exists: (path: string) => boolean = existsSync): { file: string } | { error: string } {
  const named = env[places.env];
  if (named) return exists(named) ? { file: named } : { error: `The file named by ${places.env} was not found.` };
  const root = platform === "win32" ? env.APPDATA : env.HOME;
  const rest = platform === "win32" ? places.wellKnown.windows : places.wellKnown.posix;
  if (!root) return { error: "No credential file was found on this computer." };
  const file = `${root}${platform === "win32" ? "\\" : "/"}${rest}`;
  return exists(file) ? { file } : { error: "No credential file was found on this computer." };
}

type Parsed =
  | { kind: "authorized_user"; client_id: string; client_secret: string; refresh_token: string }
  | { kind: "service_account"; client_email: string; private_key: string; token_uri?: string };

function parse(text: string): Parsed | { error: string } {
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(text) as Record<string, unknown>; } catch { return { error: "The credential file is not readable as JSON." }; }
  const str = (k: string): string | undefined => (typeof raw[k] === "string" && raw[k] ? (raw[k] as string) : undefined);
  if (raw.type === "authorized_user") {
    const client_id = str("client_id"), client_secret = str("client_secret"), refresh_token = str("refresh_token");
    return client_id && client_secret && refresh_token ? { kind: "authorized_user", client_id, client_secret, refresh_token } : { error: "The credential file lacks a client id, a client secret or a refresh token." };
  }
  if (raw.type === "service_account") {
    const client_email = str("client_email"), private_key = str("private_key"), token_uri = str("token_uri");
    return client_email && private_key ? { kind: "service_account", client_email, private_key, ...(token_uri ? { token_uri } : {}) } : { error: "The credential file lacks a client email or a private key." };
  }
  return { error: `The credential file is of a kind this program does not read (${typeof raw.type === "string" ? raw.type : "no type"}).` };
}

/** Whether the file can be used at all, said before a model is written that depends on it. Never says what is in it. */
export function checkCredentialFile(file: string): { ok: true } | { error: string } {
  let text: string;
  try { text = readFileSync(file, "utf8"); } catch { return { error: "The credential file could not be read." }; }
  const got = parse(text);
  return "error" in got ? got : { ok: true };
}

const b64 = (v: string | Buffer): string => Buffer.from(v).toString("base64url");

/** The signed assertion a service account trades for a token: RS256 over the header and the claims, valid for one hour at most. */
function assertion(p: Extract<Parsed, { kind: "service_account" }>, spec: AdcSpec, nowMs: number): string {
  const iat = Math.floor(nowMs / 1000);
  const head = `${b64(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64(JSON.stringify({ iss: p.client_email, scope: spec.scope, aud: p.token_uri ?? spec.tokenUri, iat, exp: iat + 3600 }))}`;
  return `${head}.${createSign("RSA-SHA256").update(head).sign(p.private_key).toString("base64url")}`;
}

/** Early by this much: a token is replaced before the service would turn it down, so a request never leaves with one about to end. */
const EARLY_S = 300;

/**
 * Access tokens from a credential file that stays where it is, for every request: kept until shortly before they end, then replaced (one request to the
 * service however many calls wait for it). The file is read again at each replacement, never kept; a token, a refresh token and a private key are never in a message.
 */
export function adcCredentials(spec: AdcSpec, fetchFn: typeof fetch = fetch, now: () => number = Date.now): Credentials {
  let token: { value: string; until: number } | undefined;
  let pending: Promise<string> | undefined;

  const exchange = async (): Promise<string> => {
    let text: string;
    try { text = readFileSync(spec.file, "utf8"); } catch { throw new Error("The credential file could not be read."); }
    const file = parse(text);
    if ("error" in file) throw new Error(file.error);
    const form: Record<string, string> = file.kind === "authorized_user"
      ? { grant_type: "refresh_token", client_id: file.client_id, client_secret: file.client_secret, refresh_token: file.refresh_token }
      : { grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: assertion(file, spec, now()) };
    const uri = file.kind === "service_account" && file.token_uri ? file.token_uri : spec.tokenUri;
    let res: Response;
    try { res = await fetchFn(uri, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString(), signal: AbortSignal.timeout(15_000) }); } catch { throw new Error("The sign-in service could not be reached."); }
    const body = (await res.json().catch(() => ({}))) as { access_token?: unknown; expires_in?: unknown; error?: unknown };
    if (!res.ok || typeof body.access_token !== "string" || !body.access_token) {
      const code = typeof body.error === "string" && /^[a-z_]{1,40}$/.test(body.error) ? ` (${body.error})` : "";
      throw new Error(`The sign-in service refused the credential file${code}.`);
    }
    const seconds = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 3600;
    token = { value: body.access_token, until: now() + Math.max(seconds - EARLY_S, seconds / 2) * 1000 };
    return token.value;
  };

  return {
    async headers() {
      if (token && now() < token.until) return { authorization: `Bearer ${token.value}` };
      pending ??= exchange().finally(() => { pending = undefined; });
      return { authorization: `Bearer ${await pending}` };
    },
    body: (b) => b,
  };
}
