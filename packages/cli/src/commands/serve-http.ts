/**
 * `navvied serve --http`: the engine behind a WebSocket, for browsers, desktop shells and phones.
 * One text frame is one protocol command (in) or one protocol event (out), exactly as on standard input/output.
 * The session lives in this process, so a client that reconnects with `?since=<seq>` receives what it missed.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import type { Options } from "../args.ts";
import { relayUrlFor } from "../computer.ts";
import { DeviceStore } from "../devices.ts";
import { accountPath, devicesPath, runsInCloud } from "../config.ts";
import { DEFAULT_SERVER, readAccount } from "../account.ts";
import { RELAY_PATH, SESSION_PATH, isSitePath, relayTarget, sessionTarget, siteProxy, tunnel, type Tunnel } from "../site-proxy.ts";
import { createPairing, type Decision } from "../pairing.ts";
import { configPath, loadConfig } from "../config.ts";
import { discover, listModels, saveModel, useModel } from "../model-setup.ts";
import { createHub, type Hub } from "./hub.ts";
import { startA2a } from "./a2a.ts";
import { A2aRelay } from "../a2a-relay.ts";
import { RelayHost } from "../relay-host.ts";
import { DEFAULT_SITE } from "./web.ts";
import { VERSION } from "../help.ts";
import type { IO } from "../io.ts";
import { EXIT } from "./run.ts";
import { WEB_ASSETS } from "../web-assets.ts";

/** How long an unanswered relay question waits before it is treated as refused, same as local pairing's own default. */
const RELAY_ASK_WAIT_MS = 120_000;

interface PendingAsk { deviceId: string; origin: string; code: string; resolve: (d: Decision) => void; timer: ReturnType<typeof setTimeout> }

/**
 * Lets the sidecar be paired to navvied.com the same way the interactive terminal's `/remote` does (same
 * `RelayHost`, reused rather than copied), but answered over HTTP instead of a TTY: there is no terminal here, only
 * a shell (desktop, or later mobile) that is told or asks. A question is held until it is answered, forgotten with
 * the device that asked it, or left too long, in which case it is refused by itself, the same as the terminal's own
 * `askToPair` would eventually time out a person who never looks at it.
 */
function createRelayBridge(hub: Hub, store: DeviceStore, io: IO, site: string, publish: (line: string) => void, a2a: () => A2aRelay | undefined, waitMs = RELAY_ASK_WAIT_MS) {
  let host: RelayHost | undefined;
  const pendingAsks = new Map<string, PendingAsk>();

  const settle = (id: string, choice: Decision): void => {
    const entry = pendingAsks.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    pendingAsks.delete(id);
    entry.resolve(choice);
  };

  const ask = (q: { id: string; origin: string; code: string }): Promise<Decision> =>
    new Promise((resolve) => {
      const id = randomBytes(8).toString("hex");
      const timer = setTimeout(() => settle(id, "no"), waitMs);
      timer.unref?.();
      pendingAsks.set(id, { deviceId: q.id, origin: q.origin, code: q.code, resolve, timer });
      publish(JSON.stringify({ relay: "ask", id, origin: q.origin, code: q.code }));
    });

  const relay = (): RelayHost =>
    (host ??= new RelayHost({ url: io.env.NAVVIED_RELAY_URL ?? relayUrlFor(site), site, hub, store, ask, a2a, replaced: () => publish(JSON.stringify({ relay: "replaced" })) }));

  // A device paired before (by this process or an earlier one, since the store is a file) reconnects by itself.
  if (store.list().some((d) => d.kind === "relay")) void relay().start().catch(() => undefined);

  return {
    async pair(label: string) {
      return relay().pair(label);
    },
    status() {
      return {
        connected: host?.connected ?? 0,
        devices: store.list().filter((d) => d.kind === "relay").map(({ id, label, createdAt, lastUsed, pending: p }) => ({ id, label, createdAt, lastUsed, pending: !!p })),
        waiting: [...pendingAsks.entries()].map(([id, { origin, code }]) => ({ id, origin, code })),
      };
    },
    forget(id: string) {
      // A device that was never paired here needs no `RelayHost` made just to be told to forget it.
      host?.forget(id);
      if (!host) store.remove(id);
      for (const [askId, entry] of pendingAsks) if (entry.deviceId === id) settle(askId, "no");
    },
    /** `true` once a pending question with this id existed and was answered; `false` for an id that is not (or no longer) waiting. */
    answer(id: string, choice: Decision): boolean {
      if (!pendingAsks.has(id)) return false;
      settle(id, choice);
      return true;
    },
    a2aChanged() { host?.a2aChanged(); },
    stop() {
      // Nothing is left waiting on an answer that will now never come (the timer is unref'd, so it was never
      // what kept the process alive, but the promise itself would otherwise hang until it fires on its own).
      for (const id of [...pendingAsks.keys()]) settle(id, "no");
      host?.stop();
    },
  };
}

const MAX_FRAME = 16 * 1024 * 1024;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8", ".map": "application/json",
};

const SECURITY_HEADERS: Record<string, string> = {
  "x-navvied": VERSION,
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "content-security-policy": "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
};

const same = (a: string, b: string): boolean => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** `https://host[:port]` exactly, or undefined when the text is not a plain origin. Wildcards are refused on purpose. */
export function parseOrigin(text: string): string | undefined {
  try {
    const u = new URL(text);
    return (u.protocol === "https:" || u.protocol === "http:") && u.origin === text.replace(/\/$/, "") ? u.origin : undefined;
  } catch { return undefined; }
}

export interface HttpServer {
  /** Whether a model is connected right now (it is looked for again each time this is asked). */
  connected(): boolean;
  url: string;
  port: number;
  token: string;
  /** Lets agents on the web reach this computer through the relay (or stops it, with nothing). They are carried by the computer's signed-in channel, so nothing happens on a computer that has none. */
  a2a(relay: A2aRelay | undefined): void;
  stop(): Promise<void>;
}

export interface HttpDeps {
  /** The allowed websites and devices. */
  store?: DeviceStore;
  /** An engine and history that already exist, such as the interactive session, so the page shows the same conversation. */
  hub?: Hub;
  /** Asks the person whether a website may use this engine. Without it the answer is no. */
  ask?: (question: { origin: string; code: string }) => Promise<Decision>;
  /** The site a relay pairing link opens (a test's own relay, standing in for navvied.com). */
  relaySite?: string;
  /** How long an unanswered relay question waits before it is refused by itself (a test's own, far shorter). */
  relayAskWaitMs?: number;
}

export async function startHttpServer(options: Options, io: IO, deps: HttpDeps = {}): Promise<{ ok: true; server: HttpServer } | { ok: false; error: string }> {
  const host = options.host ?? "127.0.0.1";
  const token = io.env.NAVVIED_SERVE_TOKEN ?? randomBytes(24).toString("base64url");
  if (token.length < 16) return { ok: false, error: "NAVVIED_SERVE_TOKEN must be at least 16 characters" };
  const web = options.web ? resolve(options.web) : undefined;
  if (web && !(existsSync(web) && statSync(web).isDirectory())) return { ok: false, error: `--web "${web}" is not a directory` };

  const realWeb = web ? realpathSync(web) : "";
  const allowed = new Set<string>();
  for (const text of options.allowOrigins ?? []) {
    const origin = parseOrigin(text);
    if (!origin) return { ok: false, error: `--allow-origin "${text}" must be an origin such as https://navvied.com (no path, no wildcard)` };
    allowed.add(origin);
  }
  const hub = deps.hub ?? createHub(options, io, { schedule: true });
  const store = deps.store ?? new DeviceStore(devicesPath(io.env));
  const pairing = createPairing({ store, allowed, ask: deps.ask ?? (async () => "no") });
  let publishRelay: (line: string) => void = () => undefined;
  const relaySite = deps.relaySite ?? options.site ?? io.env.NAVVIED_WEB_URL ?? DEFAULT_SITE;
  let a2aRelay: A2aRelay | undefined;
  const relay = createRelayBridge(hub, store, io, relaySite, (line) => publishRelay(line), () => a2aRelay, deps.relayAskWaitMs);

  const loopbackOnly = LOOPBACK.has(host);
  const hostOk = (req: Request): boolean => {
    const h = req.headers.get("host") ?? "";
    return !loopbackOnly || LOOPBACK.has(h.replace(/:\d+$/, ""));
  };
  const originOk = (req: Request): boolean => {
    const origin = req.headers.get("origin");
    if (!origin) return true;
    if (allowed.has(origin)) return true;
    try { return new URL(origin).host === req.headers.get("host"); } catch { return false; }
  };
  const cors = (req: Request): Record<string, string> => {
    const origin = req.headers.get("origin");
    return origin && allowed.has(origin) ? { "access-control-allow-origin": origin, "access-control-expose-headers": "x-navvied", vary: "Origin" } : {};
  };
  const KEY_PROTOCOL = "navvied-key.";
  const protocolKey = (req: Request): string | undefined => (req.headers.get("sec-websocket-protocol") ?? "").split(",").map((p) => p.trim()).find((p) => p.startsWith(KEY_PROTOCOL));
  const givenToken = (url: URL, req: Request): string => url.searchParams.get("token") ?? /^Bearer (.+)$/.exec(req.headers.get("authorization") ?? "")?.[1] ?? protocolKey(req)?.slice(KEY_PROTOCOL.length) ?? "";
  /** The app's own token, never a paired website's or device's: those are let in by `authorised` too, but must never reach anything that controls pairing itself, or a device could approve, forget or exhaust-answer another. */
  const isApp = (url: URL, req: Request): boolean => same(givenToken(url, req), token);
  const authorised = (url: URL, req: Request): boolean => {
    const given = givenToken(url, req);
    return same(given, token) || (given.length > 0 && pairing.accepts(given));
  };
  const reply = (body: ConstructorParameters<typeof Response>[0], status: number, type: string, extra: Record<string, string> = {}): Response =>
    new Response(body, { status, headers: { "content-type": type, ...SECURITY_HEADERS, ...extra } });

  const serveEmbedded = (pathname: string): Response => {
    let rel: string;
    try { rel = decodeURIComponent(pathname); } catch { return reply("bad request\n", 400, "text/plain"); }
    let key = rel === "/" ? "/index.html" : rel;
    if (!Object.hasOwn(WEB_ASSETS, key)) {
      if (extname(rel)) return reply("not found\n", 404, "text/plain");
      key = "/index.html";
    }
    const text = WEB_ASSETS[key] as string;
    // a picture is kept as text (base64) in the embedded copy: send its bytes
    const body: string | Uint8Array = text.startsWith("base64:") ? new Uint8Array(Buffer.from(text.slice(7), "base64")) : text;
    return reply(body, 200, TYPES[extname(key)] ?? "application/octet-stream", { "cache-control": "no-cache" });
  };

  const serveFile = (pathname: string): Response => {
    if (!web) return serveEmbedded(pathname);
    let rel: string;
    try { rel = normalize(decodeURIComponent(pathname)); } catch { return reply("bad request\n", 400, "text/plain"); }
    let file = join(web, rel === sep || rel === "." ? "index.html" : rel);
    if (file !== web && !file.startsWith(web + sep)) return reply("not found\n", 404, "text/plain");
    if (!existsSync(file) || statSync(file).isDirectory()) {
      if (extname(rel)) return reply("not found\n", 404, "text/plain");
      file = join(web, "index.html");
      if (!existsSync(file)) return reply("not found\n", 404, "text/plain");
    }
    const real = realpathSync(file);
    if (real !== realWeb && !real.startsWith(realWeb + sep)) return reply("not found\n", 404, "text/plain");
    return reply(Bun.file(file), 200, TYPES[extname(file)] ?? "application/octet-stream", { "cache-control": "no-cache" });
  };

  const json = (value: unknown, status: number, req: Request): Response => reply(JSON.stringify(value), status, "application/json", { "cache-control": "no-store", ...cors(req) });
  const configFile = configPath(io.env, options.config);

  /** Connecting a model from a page: what is on this computer, trying a service, keeping one. A key is written to the private file and never sent back. */
  const setup = async (req: Request, url: URL): Promise<Response> => {
    if (url.pathname === "/api/setup" && req.method === "GET") {
      const file = loadConfig(configFile);
      return json(await discover(io, file.ok ? file.value : null), 200, req);
    }
    if (req.method !== "POST") return reply("method not allowed\n", 405, "text/plain", cors(req));
    if (Number(req.headers.get("content-length") ?? 0) > 65_536) return reply("too big\n", 413, "text/plain", cors(req));
    let body: Record<string, unknown>;
    try { body = (await req.json()) as Record<string, unknown>; } catch { return json({ ok: false, error: "send a JSON object" }, 400, req); }
    if (typeof body !== "object" || body === null) return json({ ok: false, error: "send a JSON object" }, 400, req);
    const text = (k: string): string | undefined => (typeof body[k] === "string" && body[k] ? (body[k] as string) : undefined);

    if (url.pathname === "/api/setup/test") {
      const api = text("api");
      return json(await listModels(io.fetch, { baseUrl: text("baseUrl") ?? "", ...(text("apiKey") ? { apiKey: text("apiKey")! } : {}), ...(api === "chat" || api === "messages" || api === "responses" || api === "ollama" ? { api } : {}) }), 200, req);
    }
    if (url.pathname === "/api/setup/save") {
      const saved = await saveModel(configFile, { ...(text("name") ? { name: text("name")! } : {}), baseUrl: text("baseUrl") ?? "", model: text("model") ?? "", ...(text("api") ? { api: text("api")! } : {}), ...(text("apiKey") ? { apiKey: text("apiKey")! } : {}), ...(typeof body.window === "number" ? { window: body.window } : {}), ...(typeof body.makeDefault === "boolean" ? { makeDefault: body.makeDefault } : {}) }, io.fetch);
      if (!saved.ok) return json({ ok: false, error: saved.error }, 400, req);
      const restarted = hub.restart();
      return json({ ok: true, name: saved.value.name, connected: restarted.ok, ...(restarted.ok ? {} : { error: restarted.error }) }, 200, req);
    }
    if (url.pathname === "/api/setup/use") {
      const used = useModel(configFile, text("name") ?? "");
      if (!used.ok) return json({ ok: false, error: used.error }, 404, req);
      const restarted = hub.restart();
      return json({ ok: true, name: used.value.name, connected: restarted.ok, ...(restarted.ok ? {} : { error: restarted.error }) }, 200, req);
    }
    return reply("not found\n", 404, "text/plain", cors(req));
  };

  const siteDeps = { fetch: io.fetch, account: () => readAccount(accountPath(io.env, options.config)), site: io.env.NAVVIED_SERVER ?? DEFAULT_SERVER, inCloud: () => runsInCloud(options, io.env), // Read again each time: the program that joins the account may be another one than this server, and may do it after this one started.
    here: () => new DeviceStore(devicesPath(io.env)).list().find((d) => d.account !== undefined)?.account };
  const server = Bun.serve<{ since: number; isApp: boolean; detach?: () => void; cloud?: { target: string; headers: Record<string, string> }; tunnel?: Tunnel }>({
    port: options.port ?? 8787,
    hostname: host,
    maxRequestBodySize: MAX_FRAME,
    async fetch(req, srv) {
      const url = new URL(req.url);
      if (!hostOk(req)) return reply("forbidden\n", 403, "text/plain");
      if (url.pathname === "/ws") {
        if (!authorised(url, req)) return reply("unauthorised\n", 401, "text/plain");
        if (!originOk(req)) return reply("forbidden\n", 403, "text/plain");
        const since = Number(url.searchParams.get("since"));
        const chosen = protocolKey(req);
        return srv.upgrade(req, { data: { since: Number.isFinite(since) && since > 0 ? since : 0, isApp: isApp(url, req) }, ...(chosen ? { headers: { "sec-websocket-protocol": chosen } } : {}) }) ? undefined : reply("expected a WebSocket\n", 426, "text/plain");
      }
      if (url.pathname === SESSION_PATH || url.pathname === RELAY_PATH) {
        if (!originOk(req)) return reply("forbidden\n", 403, "text/plain");
        if (!authorised(url, req)) return reply("unauthorised\n", 401, "text/plain");
        const to = url.pathname === RELAY_PATH
          ? relayTarget({ inCloud: siteDeps.inCloud, site: relaySite, relayUrl: () => io.env.NAVVIED_RELAY_URL ?? relayUrlFor(siteDeps.account()?.server ?? relaySite) })
          : sessionTarget(siteDeps, url);
        if (!to.ok) return reply(JSON.stringify({ error: to.error }), to.status, "application/json");
        const chosen = protocolKey(req);
        return srv.upgrade(req, { data: { since: 0, isApp: false, cloud: to }, ...(chosen ? { headers: { "sec-websocket-protocol": chosen } } : {}) }) ? undefined : reply("expected a WebSocket\n", 426, "text/plain");
      }
      if (req.method === "OPTIONS") {
        const origin = req.headers.get("origin");
        if (!origin || !allowed.has(origin)) return reply("forbidden\n", 403, "text/plain");
        return reply(null, 204, "text/plain", { ...cors(req), "access-control-allow-methods": "GET, POST, DELETE", "access-control-allow-headers": "authorization, content-type", "access-control-max-age": "600", ...(req.headers.get("access-control-request-private-network") === "true" ? { "access-control-allow-private-network": "true" } : {}) });
      }
      if (url.pathname === "/api/pair" && req.method === "POST") {
        if (!hostOk(req)) return reply("forbidden\n", 403, "text/plain");
        const asked = pairing.request(req.headers.get("origin"));
        if (!asked.ok) return reply(asked.status === 429 ? "try again in a moment\n" : "forbidden\n", asked.status, "text/plain", cors(req));
        return reply(JSON.stringify({ id: asked.id, code: asked.code, expiresIn: asked.expiresIn }), 200, "application/json", { "cache-control": "no-store", ...cors(req) });
      }
      const polled = /^\/api\/pair\/([A-Za-z0-9_-]{8,64})$/.exec(url.pathname);
      if (polled && req.method === "GET") {
        const result = pairing.poll(polled[1]!, req.headers.get("origin"));
        if (!result) return reply("not found\n", 404, "text/plain", cors(req));
        return reply(JSON.stringify(result), 200, "application/json", { "cache-control": "no-store", ...cors(req) });
      }
      if (url.pathname === "/api/devices" && req.method === "GET") {
        if (!originOk(req)) return reply("forbidden\n", 403, "text/plain");
        if (!authorised(url, req)) return reply("unauthorised\n", 401, "text/plain", cors(req));
        return reply(JSON.stringify({ devices: store.list().map(({ id, kind, label, origin, createdAt, lastUsed }) => ({ id, kind, label, origin, createdAt, lastUsed })) }), 200, "application/json", { "cache-control": "no-store", ...cors(req) });
      }
      const revoked = /^\/api\/devices\/([A-Za-z0-9_-]{1,64})$/.exec(url.pathname);
      if (revoked && req.method === "DELETE") {
        if (!originOk(req)) return reply("forbidden\n", 403, "text/plain");
        if (!authorised(url, req)) return reply("unauthorised\n", 401, "text/plain", cors(req));
        return store.remove(revoked[1]!) ? reply(null, 204, "text/plain", cors(req)) : reply("not found\n", 404, "text/plain", cors(req));
      }
      // Every relay route below checks `isApp`, never `authorised`: pairing, answering and forgetting control who
      // can reach this computer at all, so a website or device already let in for ordinary use (`authorised`'s
      // other half, `pairing.accepts`) must never also be able to approve another one, read what one is waiting
      // for, or remove one — only the app itself, on its own token.
      if (url.pathname === "/api/relay/pair" && req.method === "POST") {
        if (!originOk(req)) return reply("forbidden\n", 403, "text/plain");
        if (!isApp(url, req)) return reply("unauthorised\n", 401, "text/plain", cors(req));
        if (Number(req.headers.get("content-length") ?? 0) > 65_536) return reply("too big\n", 413, "text/plain", cors(req));
        let body: unknown;
        try { const text = await req.text(); body = text ? JSON.parse(text) : {}; } catch { return json({ error: "send a JSON object" }, 400, req); }
        const label = typeof (body as { label?: unknown }).label === "string" && (body as { label: string }).label ? (body as { label: string }).label : `Device ${store.list().filter((d) => d.kind === "relay").length + 1}`;
        return relay.pair(label).then((made) => json(made, 200, req), (e: unknown) => json({ error: e instanceof Error ? e.message : "could not make a link" }, 502, req));
      }
      if (url.pathname === "/api/relay/status" && req.method === "GET") {
        if (!originOk(req)) return reply("forbidden\n", 403, "text/plain");
        if (!isApp(url, req)) return reply("unauthorised\n", 401, "text/plain", cors(req));
        return json(relay.status(), 200, req);
      }
      if (url.pathname === "/api/relay/forget" && req.method === "POST") {
        if (!originOk(req)) return reply("forbidden\n", 403, "text/plain");
        if (!isApp(url, req)) return reply("unauthorised\n", 401, "text/plain", cors(req));
        if (Number(req.headers.get("content-length") ?? 0) > 65_536) return reply("too big\n", 413, "text/plain", cors(req));
        let body: unknown;
        try { const text = await req.text(); body = text ? JSON.parse(text) : {}; } catch { return json({ error: "send a JSON object" }, 400, req); }
        relay.forget(String((body as { id?: unknown }).id ?? ""));
        return json({ ok: true }, 200, req);
      }
      if (url.pathname === "/api/relay/answer" && req.method === "POST") {
        if (!originOk(req)) return reply("forbidden\n", 403, "text/plain");
        if (!isApp(url, req)) return reply("unauthorised\n", 401, "text/plain", cors(req));
        if (Number(req.headers.get("content-length") ?? 0) > 65_536) return reply("too big\n", 413, "text/plain", cors(req));
        let body: unknown;
        try { const text = await req.text(); body = text ? JSON.parse(text) : {}; } catch { return json({ error: "send a JSON object" }, 400, req); }
        const choice = (body as { choice?: unknown }).choice;
        if (choice !== "once" && choice !== "always" && choice !== "no") return json({ error: "choice must be once, always or no" }, 400, req);
        return json({ ok: relay.answer(String((body as { id?: unknown }).id ?? ""), choice) }, 200, req);
      }
      if (isSitePath(url.pathname)) {
        if (!originOk(req)) return reply("forbidden\n", 403, "text/plain");
        if (!authorised(url, req)) return reply("unauthorised\n", 401, "text/plain");
        return (await siteProxy(siteDeps, req, url))!;
      }
      if (url.pathname.startsWith("/api/setup")) {
        if (!originOk(req)) return reply("forbidden\n", 403, "text/plain");
        if (!authorised(url, req)) return reply("unauthorised\n", 401, "text/plain", cors(req));
        return setup(req, url);
      }
      if (url.pathname === "/api/info") {
        if (!originOk(req)) return reply("forbidden\n", 403, "text/plain");
        if (!authorised(url, req)) return reply("unauthorised\n", 401, "text/plain", cors(req));
        return reply(JSON.stringify({ version: VERSION, ...hub.info() }), 200, "application/json", { "cache-control": "no-store", ...cors(req) });
      }
      if (req.method !== "GET" && req.method !== "HEAD") return reply("method not allowed\n", 405, "text/plain");
      return serveFile(url.pathname);
    },
    websocket: {
      maxPayloadLength: MAX_FRAME,
      sendPings: true,
      idleTimeout: 120,
      // Only the app's own connection hears the relay side-channel: a paired website or device's socket (the same
      // kind `pairing.accepts` lets open this connection for ordinary use) must never see another one's pairing
      // code, the same reason the HTTP routes above check `isApp`, not `authorised`.
      open(ws) {
        if (ws.data.cloud) { ws.data.tunnel = tunnel(ws.data.cloud, { send: (d) => ws.send(d), close: (code, reason) => ws.close(code, reason) }); return; }
        ws.data.detach = hub.attach(ws, ws.data.since); if (ws.data.isApp) ws.subscribe("relay"); },
      message(ws, frame) {
        if (ws.data.tunnel) { ws.data.tunnel.message(frame); return; }
        if (typeof frame !== "string") { ws.send(JSON.stringify({ ev: "error", msg: "bad command: send text frames" })); return; }
        hub.command(frame, (text) => ws.send(text));
      },
      close(ws) { ws.data.tunnel?.close(); ws.data.detach?.(); if (ws.data.isApp) ws.unsubscribe("relay"); },
    },
  });
  // A pending relay question reaches a connected shell at once, over the socket it already has open for notices
  // (`events::Tracker` on the Rust side ignores a line with no "ev" field, so this rides the same channel safely);
  // `/api/relay/status` is there too, for a shell that opens its settings page without one open yet.
  publishRelay = (line) => { server.publish("relay", line); };

  const shown = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  return {
    ok: true,
    server: {
      connected: () => hub.connected(),
      url: `http://${shown.includes(":") ? `[${shown}]` : shown}:${server.port}/?token=${token}`,
      port: server.port ?? 0,
      token,
      a2a(next) { a2aRelay?.stop(); a2aRelay = next; relay.a2aChanged(); },
      async stop() {
        a2aRelay?.stop();
        relay.stop();
        await server.stop(true);
        if (!deps.hub) await hub.stop();
      },
    },
  };
}

export async function serveHttpCommand(options: Options, io: IO): Promise<number> {
  const started = await startHttpServer(options, io);
  if (!started.ok) { io.stderr.write(`error: ${started.error}\n`); return EXIT.usage; }
  const { server } = started;
  // Agent-to-agent calls share this program but not its address or its key: a peer holds a token of its own and never the one above.
  const cfg = loadConfig(configPath(io.env, options.config), io.env);
  const a2a = options.a2a || (cfg.ok && cfg.value?.a2a?.serve) ? startA2a(options, io, cfg.ok ? cfg.value?.a2a?.port ?? 8788 : 8788) : undefined;
  if (a2a && !a2a.ok) io.stderr.write(`error: agent-to-agent calls did not start: ${a2a.error}\n`);
  if (a2a?.ok) {
    io.stderr.write(`Other agents can ask this computer at ${a2a.server.url}/ in ${a2a.config.mode} mode.\n`);
    const { tokens } = a2a;
    server.a2a(new A2aRelay({ handle: tokens.handle(), server: a2a.server, hashes: () => tokens.list().map((t) => t.hash) }));
  }
  if (options.readyLine) io.stderr.write(`navvied-ready ${JSON.stringify({ port: server.port })}\n`);
  else {
    io.stderr.write(`navvied is listening.\n\n  ${server.url}\n\nOpen that address in a browser. The token in it is the key; keep it private.\n`);
    if (!server.connected()) io.stderr.write("\nNo model is connected yet. Run `navvied init` in another terminal; this server picks it up by itself.\n");
    if (!LOOPBACK.has(options.host ?? "127.0.0.1")) io.stderr.write("Warning: this server can be reached from your network. Anyone with the token has full control of the agent.\n");
  }
  await new Promise<void>((resolveStop) => {
    const off = io.onInterrupt(() => { off(); resolveStop(); });
    if (options.exitWhenStdinCloses) void (async () => { try { for await (const _ of io.stdin) { /* nothing is expected: only the end matters */ } } catch { /* a broken pipe is an end too */ } off(); resolveStop(); })();
  });
  if (a2a?.ok) { server.a2a(undefined); await a2a.server.stop(); }
  await server.stop();
  return EXIT.ok;
}
