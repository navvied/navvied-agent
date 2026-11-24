import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { startHttpServer, type HttpServer } from "../src/commands/serve-http.ts";
import { writeAccount } from "../src/account.ts";
import { DeviceStore } from "../src/devices.ts";
import { accountPath, configPath, devicesPath } from "../src/config.ts";
import { fakeIO, remove, startMockModel, tempDir } from "./helpers.ts";

let mock: ReturnType<typeof startMockModel>;
let site: ReturnType<typeof Bun.serve>;
/** What the hub itself asks of the site in the background is not what these tests look at: only what carries the probe header is. */
const PROBE = "application/x-probe";
const all: { method: string; path: string; headers: Record<string, string>; body: string }[] = [];
const seen = { get list() { return all.filter((r) => r.headers.accept === PROBE); }, clear: () => { all.length = 0; } };
const dirs: string[] = [];
const servers: HttpServer[] = [];
beforeAll(() => {
  mock = startMockModel();
  site = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      all.push({ method: req.method, path: url.pathname + url.search, headers: Object.fromEntries(req.headers), body: await req.text() });
      if (url.pathname === "/api/account/computers") return new Response(JSON.stringify({ computers: [{ id: "c1" }, { id: "c2", name: "Other" }] }), { headers: { "content-type": "application/json", "set-cookie": "sid=1", "x-secret": "no" } });
      if (url.pathname === "/api/account/me") return new Response(JSON.stringify({ user: { email: "me@example.com", name: "Me", admin: true } }), { headers: { "content-type": "application/json" } });
      if (url.pathname === "/api/admin/hosted") return new Response(JSON.stringify({ error: "Forbidden." }), { status: 403, headers: { "content-type": "application/json" } });
      if (url.pathname === "/api/account/providers") return new Response(JSON.stringify({ password: true }), { headers: { "content-type": "application/json" } });
      if (url.pathname === "/api/hosted/status") return new Response(null, { status: 302, headers: { location: "https://elsewhere.example/" } });
      return new Response("{}", { headers: { "content-type": "application/json" } });
    },
  });
});
afterAll(async () => { for (const s of servers) await s.stop(); mock.stop(); site.stop(true); dirs.forEach(remove); });

async function start(o: { signedIn?: boolean; cloud?: boolean; joinedAs?: string } = {}) {
  const state = tempDir(), work = tempDir(), web = tempDir();
  dirs.push(state, work, web);
  const env = { NAVVIED_SERVER: `http://127.0.0.1:${site.port}`, HOME: state, XDG_STATE_HOME: state, XDG_CONFIG_HOME: state, NAVVIED_BASE_URL: mock.url, NAVVIED_MODEL: "mock-model", NAVVIED_WINDOW: "100000" };
  mkdirSync(dirname(configPath(env)), { recursive: true });
  if (o.signedIn !== false) writeAccount(accountPath(env), { server: `http://127.0.0.1:${site.port}`, token: "t-secret-token", email: "me@example.com" });
  if (o.cloud) writeFileSync(configPath(env), JSON.stringify({ models: {}, webProxy: { url: "http://x", token: "y" } }));
  if (o.joinedAs) new DeviceStore(devicesPath(env)).add({ id: "self", kind: "relay", label: "Desk", account: o.joinedAs, createdAt: 1 });
  const io = fakeIO({ env }).io;
  const started = await startHttpServer({ json: false, yes: false, thinking: false, port: 0, cwd: work, web }, io);
  if (!started.ok) throw new Error(started.error);
  servers.push(started.server);
  const { server } = started;
  const base = `http://127.0.0.1:${server.port}`;
  const call = (path: string, init: RequestInit = {}, token: string | null = server.token) => fetch(`${base}${path}`, { ...init, headers: { accept: PROBE, ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.headers as Record<string, string> | undefined) } });
  return { call, server };
}

describe("the site's account paths, answered by this computer", () => {
  test("the account's token is added on this side, and the page's own token, cookies and everything else of the page stay here", async () => {
    const c = await start();
    seen.clear();
    const res = await c.call("/api/account/computers", { headers: { cookie: "sid=page", "x-extra": "1" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ computers: [{ id: "c1" }, { id: "c2", name: "Other" }] });
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("x-secret")).toBeNull();
    const got = seen.list.at(-1)!;
    expect(got.headers.authorization).toBe("Bearer t-secret-token");
    expect(got.headers.cookie).toBeUndefined();
    expect(got.headers["x-extra"]).toBeUndefined();
    expect(JSON.stringify(got)).not.toContain(c.server.token);
  });

  test("the computer's own entry in the list of computers is marked here, and nothing else of the answer changes", async () => {
    const c = await start({ joinedAs: "c2" });
    expect(await (await c.call("/api/account/computers")).json()).toEqual({ computers: [{ id: "c1" }, { id: "c2", name: "Other", here: true }] });
    const apart = await start({ joinedAs: "c9" });
    expect(await (await apart.call("/api/account/computers")).json()).toEqual({ computers: [{ id: "c1" }, { id: "c2", name: "Other" }] });
  });

  test("the page's own token is still required; without it nothing goes to the server", async () => {
    const c = await start();
    seen.clear();
    expect((await c.call("/api/account/computers", {}, null)).status).toBe(401);
    expect((await c.call("/api/account/computers", {}, "wrong-token-wrong-token")).status).toBe(401);
    expect(seen.list).toEqual([]);
  });

  test("only the listed paths and methods go anywhere; the rest never reach the server", async () => {
    const c = await start();
    seen.clear();
    expect((await c.call("/api/account/computers", { method: "POST" })).status).toBe(405);
    expect((await c.call("/api/admin/hosted", { method: "DELETE" })).status).toBe(405);
    for (const path of ["/api/account/login", "/api/account/logout", "/api/account/device/approve", "/api/account/conversations/a/b/c", "/api/admin/other", "/api/hosted/session"]) {
      await c.call(path, { method: path.includes("login") || path.includes("device") ? "POST" : "GET" });
    }
    expect(seen.list).toEqual([]);
  });

  test("a body and a method are passed on as they are; the server's refusal is the page's answer, so the server alone decides who is an admin", async () => {
    const c = await start();
    seen.clear();
    const patched = await c.call("/api/account/computers/c1", { method: "PATCH", body: JSON.stringify({ name: "Desk" }), headers: { "content-type": "application/json" } });
    expect(patched.status).toBe(200);
    expect(seen.list.at(-1)).toMatchObject({ method: "PATCH", path: "/api/account/computers/c1", body: JSON.stringify({ name: "Desk" }) });
    expect(seen.list.at(-1)!.headers.origin).toBe(`http://127.0.0.1:${site.port}`);
    const admin = await c.call("/api/admin/hosted");
    expect(admin.status).toBe(403);
    expect(await admin.json()).toEqual({ error: "Forbidden." });
  });

  test("a redirect of the server is never followed", async () => {
    const c = await start();
    const res = await c.call("/api/hosted/status");
    expect(res.status).toBe(502);
    expect(res.headers.get("location")).toBeNull();
  });

  test("not signed in: the open paths still answer, the others say so, and /me says nobody is signed in; signed in: /me is the server's own record, and the token is not in it", async () => {
    const out = await start({ signedIn: false });
    seen.clear();
    expect((await out.call("/api/account/providers")).status).toBe(200);
    expect(seen.list.at(-1)!.headers.authorization).toBeUndefined();
    expect(await (await out.call("/api/account/me")).json()).toEqual({ user: null });
    const denied = await out.call("/api/account/computers");
    expect(denied.status).toBe(401);
    const inn = await start();
    const me = await (await inn.call("/api/account/me")).text();
    expect(JSON.parse(me)).toEqual({ user: { email: "me@example.com", name: "Me", admin: true } });
    expect(seen.list.at(-1)).toMatchObject({ path: "/api/account/me" });
    expect(me).not.toContain("t-secret-token");
  });

  test("in a cloud session there is no proxy at all", async () => {
    const c = await start({ cloud: true });
    seen.clear();
    expect((await c.call("/api/account/computers")).status).toBe(404);
    expect((await c.call("/api/account/me")).status).toBe(404);
    expect(seen.list).toEqual([]);
  });
});

describe("the cloud session, through this computer", () => {
  const upstream: { url: string; headers: Record<string, string>; got: string[]; ws?: { send(d: string): void; close(): void } }[] = [];
  let cloud: ReturnType<typeof Bun.serve>;
  beforeAll(() => {
    cloud = Bun.serve({
      port: 0,
      fetch(req, srv) {
        const url = new URL(req.url);
        if (url.pathname !== "/api/hosted/session" && url.pathname !== "/relay/ws") return new Response("no", { status: 404 });
        const entry = { url: url.pathname + url.search, headers: Object.fromEntries(req.headers), got: [] as string[] };
        upstream.push(entry);
        return srv.upgrade(req, { data: entry }) ? undefined : new Response("ws", { status: 426 });
      },
      websocket: {
        open(ws) { (ws.data as { ws?: unknown }).ws = ws; ws.send(JSON.stringify({ ev: "hello" })); },
        message(ws, m) { (ws.data as { got: string[] }).got.push(String(m)); ws.send(`echo:${String(m)}`); },
      },
    });
  });
  afterAll(() => cloud.stop(true));

  async function startCloud(o: { signedIn?: boolean; cloud?: boolean } = {}) {
    const state = tempDir(), work = tempDir(), web = tempDir();
    dirs.push(state, work, web);
    const env = { NAVVIED_SERVER: `http://127.0.0.1:${cloud.port}`, NAVVIED_RELAY_URL: `ws://127.0.0.1:${cloud.port}/relay/ws`, NAVVIED_WEB_URL: "https://site.example", HOME: state, XDG_STATE_HOME: state, XDG_CONFIG_HOME: state, NAVVIED_BASE_URL: mock.url, NAVVIED_MODEL: "mock-model", NAVVIED_WINDOW: "100000" };
    mkdirSync(dirname(configPath(env)), { recursive: true });
    if (o.signedIn !== false) writeAccount(accountPath(env), { server: `http://127.0.0.1:${cloud.port}`, token: "t-secret-token", email: "me@example.com" });
    if (o.cloud) writeFileSync(configPath(env), JSON.stringify({ models: {}, webProxy: { url: "http://x", token: "y" } }));
    const started = await startHttpServer({ json: false, yes: false, thinking: false, port: 0, cwd: work, web }, fakeIO({ env }).io);
    if (!started.ok) throw new Error(started.error);
    servers.push(started.server);
    return started.server;
  }
  const join = (server: HttpServer, query: string, token: string | null = server.token, path = "/api/hosted/session") => new WebSocket(`ws://127.0.0.1:${server.port}${path}${query}${token ? `${query ? "&" : "?"}token=${token}` : ""}`);
  const next = (ws: WebSocket) => new Promise<string>((resolve, reject) => { ws.onmessage = (m) => resolve(String(m.data)); ws.onerror = () => reject(new Error("socket error")); });
  const failed = (ws: WebSocket) => new Promise<boolean>((resolve) => { ws.onerror = () => resolve(true); ws.onopen = () => resolve(false); });

  test("what the page says reaches the cloud and what the cloud says reaches the page; the token is added on this side, and only the conversation goes on", async () => {
    const server = await startCloud();
    upstream.length = 0;
    const ws = join(server, "?conversation=abc_1&takeover=1&x=evil");
    const first = next(ws);
    expect(await first).toBe(JSON.stringify({ ev: "hello" }));
    const echoed = next(ws);
    ws.send("one");
    expect(await echoed).toBe("echo:one");
    const got = upstream.at(-1)!;
    expect(got.url).toBe("/api/hosted/session?conversation=abc_1&takeover=1");
    expect(got.headers.authorization).toBe("Bearer t-secret-token");
    expect(JSON.stringify(got)).not.toContain(server.token);
    ws.close();
  });

  test("a message sent before the cloud has answered is not lost", async () => {
    const server = await startCloud();
    upstream.length = 0;
    const ws = join(server, "");
    const echoed = new Promise<string>((resolve) => { ws.onmessage = (m) => { if (String(m.data).startsWith("echo:")) resolve(String(m.data)); }; });
    ws.onopen = () => ws.send("early");
    expect(await echoed).toBe("echo:early");
    ws.close();
  });

  test("when the cloud ends the connection, the page's ends too", async () => {
    const server = await startCloud();
    upstream.length = 0;
    const ws = join(server, "");
    const closed = new Promise<void>((resolve) => { ws.onclose = () => resolve(); });
    await next(ws);
    cloud.publish("x", "");
    for (const e of upstream) e.ws?.close();
    await closed;
  });

  test("the page's own token is required, a bad conversation, no account and a cloud session are all refused before anything reaches the server", async () => {
    const server = await startCloud();
    upstream.length = 0;
    expect(await failed(join(server, "", null))).toBe(true);
    expect(await failed(join(server, "?conversation=a/b"))).toBe(true);
    const out = await startCloud({ signedIn: false });
    expect(await failed(join(out, ""))).toBe(true);
    const inCloud = await startCloud({ cloud: true });
    expect(await failed(join(inCloud, ""))).toBe(true);
    expect(upstream).toEqual([]);
  });

  test("the relay: frames go both ways as they are, with the site as the origin and no account token, and the page's own token is still required", async () => {
    const server = await startCloud();
    upstream.length = 0;
    const ws = join(server, "", server.token, "/relay/ws");
    expect(await next(ws)).toBe(JSON.stringify({ ev: "hello" }));
    const echoed = next(ws);
    ws.send(JSON.stringify({ t: "hello", role: "client" }));
    expect(await echoed).toBe(`echo:${JSON.stringify({ t: "hello", role: "client" })}`);
    const got = upstream.at(-1)!;
    expect(got.url).toBe("/relay/ws");
    expect(got.headers.origin).toBe("https://site.example");
    expect(got.headers.authorization).toBeUndefined();
    expect(JSON.stringify(got)).not.toContain(server.token);
    ws.close();
    upstream.length = 0;
    expect(await failed(join(server, "", null, "/relay/ws"))).toBe(true);
    const inCloud = await startCloud({ cloud: true });
    expect(await failed(join(inCloud, "", inCloud.token, "/relay/ws"))).toBe(true);
    expect(upstream).toEqual([]);
  });

  test("the token may also come as the navvied-key sub-protocol, on the session and on the relay", async () => {
    const server = await startCloud();
    for (const path of ["/api/hosted/session", "/relay/ws"]) {
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}${path}`, [`navvied-key.${server.token}`]);
      expect(await next(ws)).toBe(JSON.stringify({ ev: "hello" }));
      ws.close();
    }
  });
});
