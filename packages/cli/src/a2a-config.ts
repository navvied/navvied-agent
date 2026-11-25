import type { PermMode, Result } from "@navvied/protocol";

/** A peer this computer may ask: where it is, and where its token is kept (never the token itself). */
export interface A2aPeer {
  url: string;
  /** The name of an environment variable that holds the token. */
  tokenEnv?: string;
  /** A file that holds the token (it should be private to the person). */
  tokenFile?: string;
  timeoutSeconds?: number;
}

/** The limits of the server; each is given in the configuration or has the default of `DEFAULT_LIMITS`. */
export interface A2aLimits {
  /** Requests a peer may make in a minute. */
  perMinute: number;
  /** Tasks one peer may have running at once, and all peers together. */
  tasksPerPeer: number;
  tasksTotal: number;
  /** Conversations kept per peer and in all (the oldest idle one is let go for a new one). */
  contextsPerPeer: number;
  contextsTotal: number;
  /** Messages one conversation takes before it is closed (an agent that answers an agent has no end by itself). */
  turns: number;
  /** The size of a request body, a message, and an answer. */
  bodyBytes: number;
  messageChars: number;
  answerChars: number;
  /** Wrong tokens from one address in an hour before it is turned away. */
  wrongPerHour: number;
  /** How long one task may run. */
  taskSeconds: number;
}

export const DEFAULT_LIMITS: A2aLimits = { perMinute: 30, tasksPerPeer: 2, tasksTotal: 4, contextsPerPeer: 4, contextsTotal: 16, turns: 20, bodyBytes: 64 * 1024, messageChars: 16_000, answerChars: 32_000, wrongPerHour: 20, taskSeconds: 600 };

/** What the person turned on or set for agent-to-agent calls. Everything here is off or empty until it is written. */
export interface A2aConfig {
  /** The server starts with `navvied serve --http` as well, not only with `--a2a`. */
  serve?: boolean;
  port?: number;
  /** The name and words on the card. */
  name?: string;
  description?: string;
  /** The address the card says this server is reached at (behind a proxy or a tunnel). */
  url?: string;
  /** What a conversation with a peer may do. Never more than this; a peer cannot ask for more. Default `plan`. */
  mode: Extract<PermMode, "plan" | "ask" | "edits" | "auto">;
  peers: Record<string, A2aPeer>;
  limits: A2aLimits;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
export const PEER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
const MODES = ["plan", "ask", "edits", "auto"] as const;
const LIMIT_NAMES = Object.keys(DEFAULT_LIMITS) as (keyof A2aLimits)[];

export function parseA2a(path: string, raw: unknown): Result<A2aConfig> {
  const bad = (m: string): Result<A2aConfig> => ({ ok: false, error: `${path}: a2a: ${m}` });
  if (!isObj(raw)) return bad("must be an object");
  const text = (k: string): string | undefined => (typeof raw[k] === "string" && raw[k] ? (raw[k] as string) : undefined);
  if (raw.serve !== undefined && typeof raw.serve !== "boolean") return bad('"serve" must be true or false');
  if (raw.port !== undefined && !(Number.isInteger(raw.port) && (raw.port as number) >= 0 && (raw.port as number) <= 65535)) return bad('"port" must be a whole number from 0 to 65535');
  if (raw.url !== undefined && !/^https?:\/\/[^\s@]+$/.test(String(raw.url))) return bad('"url" must be a web address such as https://agent.example.com');
  if (raw.mode !== undefined && !(MODES as readonly unknown[]).includes(raw.mode)) return bad(`"mode" must be one of ${MODES.join(", ")} (a peer never gets more than this)`);
  const peers: Record<string, A2aPeer> = {};
  if (raw.peers !== undefined) {
    if (!isObj(raw.peers)) return bad('"peers" must be an object of agents');
    for (const [name, v] of Object.entries(raw.peers)) {
      if (!PEER_NAME.test(name)) return bad(`the name "${name}" must be letters, digits, dots, dashes or underscores (at most 32)`);
      if (!isObj(v) || typeof v.url !== "string" || !/^https?:\/\/[^\s@]+$/.test(v.url)) return bad(`"${name}" needs a "url" such as http://127.0.0.1:9900 (no user name or password in it)`);
      if (v.tokenEnv !== undefined && !(typeof v.tokenEnv === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(v.tokenEnv))) return bad(`"${name}": "tokenEnv" must be the name of an environment variable`);
      if (v.tokenFile !== undefined && !(typeof v.tokenFile === "string" && v.tokenFile)) return bad(`"${name}": "tokenFile" must be a file path`);
      if (v.token !== undefined) return bad(`"${name}": a token is not written here. Put it in an environment variable ("tokenEnv") or a private file ("tokenFile")`);
      if (v.timeoutSeconds !== undefined && !(typeof v.timeoutSeconds === "number" && v.timeoutSeconds >= 1 && v.timeoutSeconds <= 3600)) return bad(`"${name}": "timeoutSeconds" must be from 1 to 3600`);
      peers[name] = { url: v.url, ...(v.tokenEnv ? { tokenEnv: v.tokenEnv as string } : {}), ...(v.tokenFile ? { tokenFile: v.tokenFile as string } : {}), ...(v.timeoutSeconds ? { timeoutSeconds: v.timeoutSeconds as number } : {}) };
    }
  }
  const limits: A2aLimits = { ...DEFAULT_LIMITS };
  if (raw.limits !== undefined) {
    if (!isObj(raw.limits)) return bad('"limits" must be an object');
    for (const [k, v] of Object.entries(raw.limits)) {
      if (!LIMIT_NAMES.includes(k as keyof A2aLimits)) return bad(`"limits.${k}" is not a limit (${LIMIT_NAMES.join(", ")})`);
      if (!(typeof v === "number" && Number.isInteger(v) && v >= 1)) return bad(`"limits.${k}" must be a positive whole number`);
      limits[k as keyof A2aLimits] = v;
    }
  }
  return { ok: true, value: { ...(raw.serve === true ? { serve: true } : {}), ...(typeof raw.port === "number" ? { port: raw.port } : {}), ...(text("name") ? { name: text("name")! } : {}), ...(text("description") ? { description: text("description")! } : {}), ...(text("url") ? { url: text("url")!.replace(/\/+$/, "") } : {}), mode: (raw.mode as A2aConfig["mode"] | undefined) ?? "plan", peers, limits } };
}
