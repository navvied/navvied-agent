import type { SignInProvider, Tokens } from "./signin.ts";

/** The sign-in of the Claude Code program: how its saved login is read and refreshed, and what a request must carry for it to be accepted. */
const ENDPOINT = "https://console.anthropic.com/v1/oauth/token";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const BETA = "oauth-2025-04-20";
const IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

const claude: SignInProvider = {
  kind: "messages",

  read(text) {
    try {
      const saved = (JSON.parse(text) as { claudeAiOauth?: unknown }).claudeAiOauth;
      if (!isObject(saved) || typeof saved.accessToken !== "string" || !saved.accessToken || typeof saved.refreshToken !== "string" || !saved.refreshToken) return undefined;
      return { access: saved.accessToken, refresh: saved.refreshToken, expiresAt: typeof saved.expiresAt === "number" ? saved.expiresAt : 0 };
    } catch { return undefined; }
  },

  write(text, tokens: Tokens) {
    const all = JSON.parse(text) as Record<string, unknown>;
    const saved = isObject(all.claudeAiOauth) ? all.claudeAiOauth : {};
    return JSON.stringify({ ...all, claudeAiOauth: { ...saved, accessToken: tokens.access, refreshToken: tokens.refresh, expiresAt: tokens.expiresAt } });
  },

  async refresh(refresh, send, now) {
    const res = await send(ENDPOINT, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ grant_type: "refresh_token", refresh_token: refresh, client_id: CLIENT_ID }) }).catch(() => undefined);
    if (!res) return undefined;
    const answer = await res.json().catch(() => undefined) as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; error?: unknown } | undefined;
    if (!res.ok) return answer?.error === "invalid_grant" ? "rejected" : undefined;
    if (typeof answer?.access_token !== "string") return undefined;
    const seconds = typeof answer.expires_in === "number" ? answer.expires_in : 3600;
    return { access: answer.access_token, refresh: typeof answer.refresh_token === "string" ? answer.refresh_token : refresh, expiresAt: now + seconds * 1000 };
  },

  headers(access, incoming) {
    const beta = new Set((incoming.get("anthropic-beta") ?? "").split(",").map((s) => s.trim()).filter(Boolean));
    beta.add(BETA);
    return { authorization: `Bearer ${access}`, "anthropic-beta": [...beta].join(",") };
  },

  /** The service accepts this sign-in only when the first thing the model is told is who it is working for. */
  body(body) {
    const system = body.system;
    const first = { type: "text", text: IDENTITY };
    const rest = typeof system === "string" ? [{ type: "text", text: system }] : Array.isArray(system) ? system : [];
    return { ...body, system: [first, ...rest] };
  },
};

/** The sign-in of the ChatGPT plan, as the Codex program saves it (`auth.json`). Reached with the responses API. */
const CHATGPT_ENDPOINT = "https://auth.openai.com/oauth/token";
const CHATGPT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

const claims = (jwt: string): Record<string, unknown> | undefined => {
  try { const v: unknown = JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString("utf8")); return isObject(v) ? v : undefined; } catch { return undefined; }
};

const chatgpt: SignInProvider = {
  kind: "responses",

  read(text) {
    try {
      const saved = (JSON.parse(text) as { tokens?: unknown }).tokens;
      if (!isObject(saved) || typeof saved.access_token !== "string" || !saved.access_token || typeof saved.refresh_token !== "string" || !saved.refresh_token) return undefined;
      const exp = claims(saved.access_token)?.exp;
      return { access: saved.access_token, refresh: saved.refresh_token, expiresAt: typeof exp === "number" ? exp * 1000 : 0 };
    } catch { return undefined; }
  },

  write(text, tokens: Tokens) {
    const all = JSON.parse(text) as Record<string, unknown>;
    const saved = isObject(all.tokens) ? all.tokens : {};
    return JSON.stringify({ ...all, tokens: { ...saved, access_token: tokens.access, refresh_token: tokens.refresh }, last_refresh: new Date().toISOString() });
  },

  async refresh(refresh, send, now) {
    const res = await send(CHATGPT_ENDPOINT, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_id: CHATGPT_CLIENT_ID, grant_type: "refresh_token", refresh_token: refresh, scope: "openid profile email" }) }).catch(() => undefined);
    if (!res) return undefined;
    const answer = await res.json().catch(() => undefined) as { access_token?: unknown; refresh_token?: unknown; error?: unknown } | undefined;
    if (!res.ok) {
      const named = isObject(answer?.error) ? (answer.error as { code?: unknown }).code : answer?.error;
      return res.status === 401 || named === "invalid_grant" || named === "refresh_token_expired" || named === "refresh_token_reused" || named === "refresh_token_invalidated" ? "rejected" : undefined;
    }
    if (typeof answer?.access_token !== "string") return undefined;
    const exp = claims(answer.access_token)?.exp;
    return { access: answer.access_token, refresh: typeof answer.refresh_token === "string" ? answer.refresh_token : refresh, expiresAt: typeof exp === "number" ? exp * 1000 : now + 3_600_000 };
  },

  headers(access) {
    const auth = claims(access)?.["https://api.openai.com/auth"];
    const account = isObject(auth) && typeof auth.chatgpt_account_id === "string" ? auth.chatgpt_account_id : undefined;
    return { authorization: `Bearer ${access}`, ...(account ? { "chatgpt-account-id": account } : {}), originator: "codex_cli_rs", "openai-beta": "responses=experimental", accept: "text/event-stream" };
  },

  /** The service keeps no copy of a conversation for this sign-in and answers only as a stream. */
  body(body) { return { ...body, store: false, stream: true }; },
};

export const SIGN_IN_PROVIDERS: Record<string, SignInProvider> = { claude, chatgpt };
