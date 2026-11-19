/**
 * `navvied serve --http`: the engine behind a WebSocket, for browsers, desktop shells and phones.
 * One text frame is one protocol command (in) or one protocol event (out), exactly as on standard input/output.
 * The session lives in this process, so a client that reconnects with `?since=<seq>` receives what it missed.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import type { Options } from "../args.ts";
import { DeviceStore } from "../devices.ts";
import { devicesPath } from "../config.ts";
import { createPairing, type Decision } from "../pairing.ts";
import { configPath, loadConfig } from "../config.ts";
import { discover, listModels, saveModel, useModel } from "../model-setup.ts";
import { createHub, type Hub } from "./hub.ts";
import { VERSION } from "../help.ts";
import type { IO } from "../io.ts";
import { EXIT } from "./run.ts";
import { WEB_ASSETS } from "../web-assets.ts";

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
  stop(): Promise<void>;
}

export interface HttpDeps {
  /** The allowed websites and devices. */
  store?: DeviceStore;
  /** An engine and history that already exist, such as the interactive session, so the page shows the same conversation. */
  hub?: Hub;
  /** Asks the person whether a website may use this engine. Without it the answer is no. */
  ask?: (question: { origin: string; code: string }) => Promise<Decision>;
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
  const authorised = (url: URL, req: Request): boolean => {
    const given = url.searchParams.get("token") ?? /^Bearer (.+)$/.exec(req.headers.get("authorization") ?? "")?.[1] ?? protocolKey(req)?.slice(KEY_PROTOCOL.length) ?? "";
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

  const server = Bun.serve<{ since: number; detach?: () => void }>({
    port: options.port ?? 8787,
    hostname: host,
    maxRequestBodySize: MAX_FRAME,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (!hostOk(req)) return reply("forbidden\n", 403, "text/plain");
      if (url.pathname === "/ws") {
        if (!authorised(url, req)) return reply("unauthorised\n", 401, "text/plain");
        if (!originOk(req)) return reply("forbidden\n", 403, "text/plain");
        const since = Number(url.searchParams.get("since"));
        const chosen = protocolKey(req);
        return srv.upgrade(req, { data: { since: Number.isFinite(since) && since > 0 ? since : 0 }, ...(chosen ? { headers: { "sec-websocket-protocol": chosen } } : {}) }) ? undefined : reply("expected a WebSocket\n", 426, "text/plain");
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
      open(ws) { ws.data.detach = hub.attach(ws, ws.data.since); },
      message(ws, frame) {
        if (typeof frame !== "string") { ws.send(JSON.stringify({ ev: "error", msg: "bad command: send text frames" })); return; }
        hub.command(frame, (text) => ws.send(text));
      },
      close(ws) { ws.data.detach?.(); },
    },
  });

  const shown = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  return {
    ok: true,
    server: {
      connected: () => hub.connected(),
      url: `http://${shown.includes(":") ? `[${shown}]` : shown}:${server.port}/?token=${token}`,
      port: server.port ?? 0,
      token,
      async stop() {
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
  await server.stop();
  return EXIT.ok;
}
