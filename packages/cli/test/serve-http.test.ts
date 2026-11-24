import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseEvent, type Stamped } from "@navvied/protocol";
import { parseOrigin, startHttpServer, type HttpDeps, type HttpServer } from "../src/commands/serve-http.ts";
import type { Options } from "../src/args.ts";
import { SIGN_IN_PROGRAMS } from "../src/presets.ts";
import { fakeIO, remove, startMockModel, tempDir, until } from "./helpers.ts";

let mock: ReturnType<typeof startMockModel>;
const dirs: string[] = [];
const servers: HttpServer[] = [];
beforeAll(() => { mock = startMockModel(); });
afterAll(async () => { for (const s of servers) await s.stop(); mock.stop(); dirs.forEach(remove); });

async function start(extra: Partial<Options> = {}, env: Record<string, string> = {}, deps: HttpDeps = {}) {
  const state = tempDir(), work = tempDir(), web = tempDir();
  dirs.push(state, work, web);
  const io = fakeIO({ env: { HOME: state, XDG_STATE_HOME: state, NAVVIED_BASE_URL: mock.url, NAVVIED_MODEL: "mock-model", NAVVIED_WINDOW: "100000", ...env } }).io;
  const started = await startHttpServer({ json: false, yes: false, thinking: false, port: 0, cwd: work, web, ...extra }, io, deps);
  if (!started.ok) throw new Error(started.error);
  servers.push(started.server);
  const { server } = started;
  return { server, web, work, base: `http://127.0.0.1:${server.port}`, ws: (query = "", headers: Record<string, string> = {}) => new WebSocket(`ws://127.0.0.1:${server.port}/ws?token=${server.token}${query}`, { headers } as never) };
}

function collect(ws: WebSocket): Stamped[] {
  const got: Stamped[] = [];
  ws.onmessage = (m) => { const r = parseEvent(String(m.data)); if (r.ok && r.value.ev !== "synced") got.push(r.value); };
  return got;
}
const opened = (ws: WebSocket): Promise<void> => new Promise((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error("socket error")); });

describe("serve --http for a page on another site", () => {
  const SITE = "https://beta.example";
  const upgrade = { connection: "Upgrade", upgrade: "websocket", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-version": "13" };

  test("an allowed site gets CORS and the private-network reply on the preflight and on the info route; others get 403", async () => {
    const { base, server } = await start({ allowOrigins: [SITE] });
    const pre = await fetch(`${base}/api/info`, { method: "OPTIONS", headers: { origin: SITE, "access-control-request-method": "GET", "access-control-request-private-network": "true" } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe(SITE);
    expect(pre.headers.get("access-control-allow-private-network")).toBe("true");
    expect(pre.headers.get("vary")).toBe("Origin");
    expect((await fetch(`${base}/api/info`, { method: "OPTIONS", headers: { origin: "https://evil.example" } })).status).toBe(403);
    expect((await fetch(`${base}/api/info`, { method: "OPTIONS" })).status).toBe(403);

    const ok = await fetch(`${base}/api/info?token=${server.token}`, { headers: { origin: SITE } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("access-control-allow-origin")).toBe(SITE);
    expect((await fetch(`${base}/api/info?token=${server.token}`, { headers: { origin: "https://evil.example" } })).status).toBe(403);
    const denied = await fetch(`${base}/api/info?token=wrong-token-value`, { headers: { origin: SITE } });
    expect(denied.status).toBe(401);
    expect(denied.headers.get("access-control-allow-origin")).toBe(SITE);
  });

  test("the socket opens from an allowed site with the token, and not from another site or without the token", async () => {
    const { base, server, ws } = await start({ allowOrigins: [SITE] });
    const socket = ws("", { origin: SITE });
    const got = collect(socket);
    await opened(socket);
    await until(() => got.some((e) => e.ev === "caps"));
    socket.close();
    expect((await fetch(`${base}/ws?token=${server.token}`, { headers: { ...upgrade, origin: "https://evil.example" } })).status).toBe(403);
    expect((await fetch(`${base}/ws?token=nope-nope-nope-nope`, { headers: { ...upgrade, origin: SITE } })).status).toBe(401);
  });

  test("without --allow-origin a foreign site is refused, and only plain origins are accepted as values", async () => {
    const { base, server } = await start();
    expect((await fetch(`${base}/api/info?token=${server.token}`, { headers: { origin: SITE } })).status).toBe(403);
    for (const bad of ["*", "https://beta.example/app", "ftp://beta.example", "beta.example", ""]) {
      const io = fakeIO({ env: { NAVVIED_BASE_URL: mock.url, NAVVIED_MODEL: "m" } }).io;
      const r = await startHttpServer({ json: false, yes: false, thinking: false, port: 0, allowOrigins: [bad] }, io);
      expect(r.ok).toBe(false);
    }
    expect(parseOrigin("https://beta.example/")).toBe("https://beta.example");
    expect(parseOrigin("http://localhost:3000")).toBe("http://localhost:3000");
  });
});

describe("serve --http without a model", () => {
  async function bare() {
    const state = tempDir(), work = tempDir();
    dirs.push(state, work);
    const env: Record<string, string> = { HOME: state, XDG_STATE_HOME: state };
    const started = await startHttpServer({ json: false, yes: false, thinking: false, port: 0, cwd: work }, fakeIO({ env }).io);
    if (!started.ok) throw new Error(started.error);
    servers.push(started.server);
    const { server } = started;
    const info = async () => (await (await fetch(`http://127.0.0.1:${server.port}/api/info?token=${server.token}`)).json()) as { model: string | null; session: string | null };
    return { server, env, info, ws: () => new WebSocket(`ws://127.0.0.1:${server.port}/ws?token=${server.token}`) };
  }

  test("it starts, says there is no model, and answers a prompt with a clear error instead of crashing", async () => {
    const { server, info, ws } = await bare();
    expect(server.connected()).toBe(false);
    expect(await info()).toEqual({ ...(await info()), model: null, session: null });
    const socket = ws();
    const got = collect(socket);
    await opened(socket);
    socket.send(JSON.stringify({ cmd: "prompt", text: "hello", qid: "q-1" }));
    await until(() => got.some((e) => e.ev === "done"));
    expect(got.map((e) => e.ev)).toEqual(["error", "done"]);
    expect((got[0] as { msg: string }).msg).toBe("No model is connected. Run `navvied init`.");
    socket.close();
  });

  test("a model configured later is noticed without anyone asking: connected sockets receive the session by themselves", async () => {
    const { server, env, ws } = await bare();
    const socket = ws();
    const got = collect(socket);
    await opened(socket);
    expect(got).toEqual([]);
    Object.assign(env, { NAVVIED_BASE_URL: mock.url, NAVVIED_MODEL: "mock-model", NAVVIED_WINDOW: "100000" });
    await until(() => got.some((e) => e.ev === "caps"), 4000);
    expect(server.connected()).toBe(true);
    expect(got.slice(0, 2).map((e) => e.ev)).toEqual(["session", "caps"]);
    socket.close();
  });

  test("when a model is configured later it connects by itself: info reports it, clients get the session, prompts work", async () => {
    const { server, env, info, ws } = await bare();
    const socket = ws();
    const got = collect(socket);
    await opened(socket);
    Object.assign(env, { NAVVIED_BASE_URL: mock.url, NAVVIED_MODEL: "mock-model", NAVVIED_WINDOW: "100000" });
    expect((await info()).model).toBe("mock-model");
    expect(server.connected()).toBe(true);
    await until(() => got.some((e) => e.ev === "caps"));
    expect(got.slice(0, 2).map((e) => e.ev)).toEqual(["session", "caps"]);
    socket.send(JSON.stringify({ cmd: "prompt", text: "hello", qid: "q-2", mode: "auto" }));
    await until(() => got.some((e) => e.ev === "done"));
    expect(got.filter((e) => e.ev === "text").map((e) => (e as { text: string }).text).join("")).toBe("all done here");
    socket.close();
  });

  test("a damaged configuration is reported as such, not as a missing model", async () => {
    const { env, ws } = await bare();
    const path = join(env.HOME!, "bad.json");
    writeFileSync(path, "{broken");
    env.NAVVIED_CONFIG = path;
    const socket = ws();
    const got = collect(socket);
    await opened(socket);
    socket.send(JSON.stringify({ cmd: "prompt", text: "hello" }));
    await until(() => got.some((e) => e.ev === "done"));
    expect((got[0] as { msg: string }).msg).toMatch(/^No model is connected: .*bad\.json/);
    socket.close();
  });
});

describe("serve --http", () => {
  test("every reply carries the x-navvied header, so a page can tell this server from any other", async () => {
    const { base, server } = await start({ allowOrigins: ["https://beta.example"] });
    for (const path of ["/", "/main.js", "/missing.js", "/api/info", `/api/info?token=${server.token}`]) {
      expect((await fetch(`${base}${path}`)).headers.get("x-navvied")).toMatch(/^\d+\.\d+\.\d+/);
    }
    const cross = await fetch(`${base}/api/info?token=${server.token}`, { headers: { origin: "https://beta.example" } });
    expect(cross.headers.get("access-control-expose-headers")).toBe("x-navvied");
  });

  test("a client gets the session and capabilities, runs a turn, and the stream is numbered", async () => {
    const { ws } = await start();
    const socket = ws();
    const got = collect(socket);
    await opened(socket);
    socket.send(JSON.stringify({ cmd: "prompt", text: "hello", qid: "q-1", mode: "auto" }));
    await until(() => got.some((e) => e.ev === "done"));
    expect(got.slice(0, 2).map((e) => e.ev)).toEqual(["session", "caps"]);
    expect(got.filter((e) => e.ev === "text").map((e) => (e as { text: string }).text).join("")).toBe("all done here");
    expect(got.map((e) => e.seq)).toEqual(got.map((_, i) => i + 1));
    socket.close();
  });

  test("a client that reconnects with ?since receives only what it missed; a fresh one receives everything", async () => {
    const { ws } = await start();
    const first = ws();
    const got = collect(first);
    await opened(first);
    first.send(JSON.stringify({ cmd: "prompt", text: "hello", qid: "q-2", mode: "auto" }));
    await until(() => got.some((e) => e.ev === "done"));
    const lastSeen = got[3]!.seq;
    first.close();

    const resumed = ws(`&since=${lastSeen}`);
    const missed = collect(resumed);
    await opened(resumed);
    await until(() => missed.length === got.length - 4);
    expect(missed.map((e) => e.seq)).toEqual(got.slice(4).map((e) => e.seq));

    const fresh = ws();
    const all = collect(fresh);
    await opened(fresh);
    await until(() => all.length === got.length);
    resumed.close(); fresh.close();
  });

  test("two clients see the same events", async () => {
    const { ws } = await start();
    const a = ws(), b = ws();
    const ga = collect(a), gb = collect(b);
    await Promise.all([opened(a), opened(b)]);
    a.send(JSON.stringify({ cmd: "prompt", text: "hello", qid: "q-3", mode: "auto" }));
    await until(() => ga.some((e) => e.ev === "done") && gb.some((e) => e.ev === "done"));
    expect(gb.map((e) => e.seq)).toEqual(ga.map((e) => e.seq));
    a.close(); b.close();
  });

  test("one window lists the saved conversations and opens one, and every window sees the same", async () => {
    const { ws } = await start();
    const a = ws(), b = ws();
    const ga = collect(a), gb = collect(b);
    await Promise.all([opened(a), opened(b)]);
    a.send(JSON.stringify({ cmd: "prompt", text: "remember the alpha topic", qid: "q-s1", mode: "auto" }));
    await until(() => ga.some((e) => e.ev === "done") && gb.some((e) => e.ev === "done"));
    b.send(JSON.stringify({ cmd: "sessions" }));
    await until(() => ga.some((e) => e.ev === "sessions") && gb.some((e) => e.ev === "sessions"));
    const listed = ga.find((e) => e.ev === "sessions") as unknown as { items: { id: string; title: string }[] };
    expect(listed.items[0]!.title).toContain("alpha topic");
    b.send(JSON.stringify({ cmd: "load", id: listed.items[0]!.id }));
    await until(() => ga.some((e) => e.ev === "loaded") && gb.some((e) => e.ev === "loaded"));
    const opened1 = ga.find((e) => e.ev === "loaded") as unknown as { items: { k: string; text: string }[] };
    expect(opened1.items[0]).toMatchObject({ k: "user", text: "remember the alpha topic" });
    a.close(); b.close();
  });

  test("a model reached through a program: its conversations are listed and opened for every window too", async () => {
    const dir = tempDir(); dirs.push(dir);
    const config = join(dir, "config.json");
    writeFileSync(config, JSON.stringify({ default: "prog", models: { prog: { command: "bun", args: [join(import.meta.dir, "../../stream-engine/test/fake-agent.ts")], window: 100000 } } }));
    const { ws } = await start({ config }, { NAVVIED_BASE_URL: "", NAVVIED_MODEL: "" });
    const a = ws(), b = ws();
    const ga = collect(a), gb = collect(b);
    await Promise.all([opened(a), opened(b)]);
    a.send(JSON.stringify({ cmd: "prompt", text: "hello from the program", qid: "q-p1", mode: "auto" }));
    await until(() => ga.some((e) => e.ev === "done") && gb.some((e) => e.ev === "done"));
    b.send(JSON.stringify({ cmd: "sessions" }));
    await until(() => ga.some((e) => e.ev === "sessions") && gb.some((e) => e.ev === "sessions"));
    const listed = ga.find((e) => e.ev === "sessions") as unknown as { items: { id: string; title: string; messages: number }[] };
    expect(listed.items[0]).toMatchObject({ title: "hello from the program" });
    a.send(JSON.stringify({ cmd: "load", id: listed.items[0]!.id }));
    await until(() => ga.some((e) => e.ev === "loaded") && gb.some((e) => e.ev === "loaded"));
    const opened1 = ga.find((e) => e.ev === "loaded") as unknown as { items: { k: string; text: string }[] };
    expect(opened1.items[0]).toMatchObject({ k: "user", text: "hello from the program" });
    expect(typeof (opened1.items[0] as { qid?: unknown }).qid).toBe("string");
    expect(opened1.items.some((i) => i.k === "assistant")).toBe(true);
    a.close(); b.close();
  });

  test("bad input is answered with an error to that client only and the server carries on", async () => {
    const { ws } = await start();
    const a = ws(), b = ws();
    const ga = collect(a), gb = collect(b);
    await Promise.all([opened(a), opened(b)]);
    a.send("not json");
    a.send(JSON.stringify({ cmd: "explode" }));
    await until(() => ga.filter((e) => e.ev === "error").length === 2);
    expect(gb.some((e) => e.ev === "error")).toBe(false);
    a.send(JSON.stringify({ cmd: "prompt", text: "still alive", mode: "auto" }));
    await until(() => ga.some((e) => e.ev === "done"));
    a.close(); b.close();
  });

  test("without the right token nothing is served: the socket and the info route answer 401", async () => {
    const { base, server } = await start();
    expect((await fetch(`${base}/ws?token=wrong`)).status).toBe(401);
    expect((await fetch(`${base}/ws`)).status).toBe(401);
    expect((await fetch(`${base}/api/info`)).status).toBe(401);
    expect((await fetch(`${base}/api/info?token=${server.token}x`)).status).toBe(401);
    const ok = await fetch(`${base}/api/info`, { headers: { authorization: `Bearer ${server.token}` } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ model: "mock-model" });
  });

  test("a page from another site cannot open the socket, and a forged Host is refused on loopback", async () => {
    const { base, server } = await start();
    const blocked = await fetch(`${base}/ws?token=${server.token}`, { headers: { origin: "https://evil.example", connection: "Upgrade", upgrade: "websocket", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-version": "13" } });
    expect(blocked.status).toBe(403);
    const rebound = await fetch(`${base}/api/info?token=${server.token}`, { headers: { host: "evil.example" } });
    expect(rebound.status).toBe(403);
  });

  test("it serves the front-end folder, falls back to index.html for app routes, and cannot be walked out of", async () => {
    const { base, web } = await start();
    writeFileSync(join(web, "index.html"), "<h1>app</h1>");
    mkdirSync(join(web, "assets"));
    writeFileSync(join(web, "assets", "app.js"), "console.log(1)");
    writeFileSync(join(tempDirOutside(web), "secret.txt"), "top secret");
    const home = await fetch(`${base}/`);
    expect(await home.text()).toBe("<h1>app</h1>");
    expect(home.headers.get("content-type")).toContain("text/html");
    expect(home.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(home.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await fetch(`${base}/assets/app.js`)).headers.get("content-type")).toContain("javascript");
    expect(await (await fetch(`${base}/chat/some-route`)).text()).toBe("<h1>app</h1>");
    expect((await fetch(`${base}/missing.js`)).status).toBe(404);
    for (const path of ["/..%2f..%2fetc%2fpasswd", "/%2e%2e/%2e%2e/etc/passwd", "/assets/..%2f..%2fsecret.txt", "/outside-link/secret.txt"]) {
      const res = await fetch(`${base}${path}`);
      const body = await res.text();
      expect(body).not.toContain("root:");
      expect(body).not.toContain("top secret");
    }
    expect((await fetch(`${base}/`, { method: "POST" })).status).toBe(405);
  });

  test("a stable token can be supplied; a short one is refused; a missing front-end folder is an error", async () => {
    const stable = await start({}, { NAVVIED_SERVE_TOKEN: "a-long-enough-token-1234" });
    expect(stable.server.token).toBe("a-long-enough-token-1234");
    const io = fakeIO({ env: { NAVVIED_SERVE_TOKEN: "short" } }).io;
    expect(await startHttpServer({ json: false, yes: false, thinking: false, port: 0 }, io)).toEqual({ ok: false, error: "NAVVIED_SERVE_TOKEN must be at least 16 characters" });
    const none = await startHttpServer({ json: false, yes: false, thinking: false, port: 0, web: "/definitely/not/here" }, fakeIO({ env: { NAVVIED_BASE_URL: mock.url, NAVVIED_MODEL: "m" } }).io);
    expect(none.ok).toBe(false);
  });
});

function tempDirOutside(web: string): string {
  const outside = tempDir();
  dirs.push(outside);
  symlinkSync(outside, join(web, "outside-link"), "junction"); // a folder link Windows lets anyone make; other systems ignore the type
  return outside;
}

describe("a website that asks to be let in, instead of being handed a token", () => {
  const SITE = "https://beta.example";
  const post = (base: string, origin?: string) => fetch(`${base}/api/pair`, { method: "POST", headers: origin ? { origin } : {} });
  const answered = async (base: string, id: string, origin: string) => {
    for (let i = 0; i < 100; i++) {
      const r = await fetch(`${base}/api/pair/${id}`, { headers: { origin } });
      const body = (await r.json()) as { state: string; key?: string };
      if (body.state !== "waiting") return body;
      await new Promise((done) => setTimeout(done, 10));
    }
    throw new Error("no answer");
  };

  test("the person is asked with the code the page is shown; a yes gives the page a key that opens the socket and the info route", async () => {
    const asked: { origin: string; code: string }[] = [];
    const { base, server } = await start({ allowOrigins: [SITE] }, {}, { ask: async (q) => { asked.push(q); return "once"; } });
    const res = await post(base, SITE);
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(SITE);
    const { id, code } = (await res.json()) as { id: string; code: string };
    const done = await answered(base, id, SITE);
    expect(asked).toEqual([{ origin: SITE, code }]);
    expect(done.state).toBe("allowed");
    const key = done.key!;
    expect(key).not.toBe(server.token);

    const info = await fetch(`${base}/api/info`, { headers: { authorization: `Bearer ${key}`, origin: SITE } });
    expect(info.status).toBe(200);
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, { protocols: [`navvied-key.${key}`], headers: { origin: SITE } } as never);
    await opened(ws);
    expect(ws.protocol).toBe(`navvied-key.${key}`);
    ws.close();
  });
  test("a wrong key is refused on the socket and the info route", async () => {
    const { base, server } = await start({ allowOrigins: [SITE] }, {}, { ask: async () => "once" });
    expect((await fetch(`${base}/api/info`, { headers: { authorization: "Bearer nope" } })).status).toBe(401);
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, { protocols: ["navvied-key.nope"], headers: { origin: SITE } } as never);
    await expect(opened(ws)).rejects.toThrow();
  });
  test("a website that is not allowed, or a request with no origin, is refused and the person is never asked", async () => {
    let asked = 0;
    const { base } = await start({ allowOrigins: [SITE] }, {}, { ask: async () => { asked++; return "once"; } });
    expect((await post(base, "https://evil.example")).status).toBe(403);
    expect((await post(base)).status).toBe(403);
    expect(asked).toBe(0);
  });
  test("a no gives no key", async () => {
    const { base } = await start({ allowOrigins: [SITE] }, {}, { ask: async () => "no" });
    const { id } = (await (await post(base, SITE)).json()) as { id: string };
    expect(await answered(base, id, SITE)).toEqual({ state: "denied" });
  });
  test("with no way to ask, every request is a no", async () => {
    const { base } = await start({ allowOrigins: [SITE] });
    const { id } = (await (await post(base, SITE)).json()) as { id: string };
    expect(await answered(base, id, SITE)).toEqual({ state: "denied" });
  });
  test("a remembered site is listed without any secret, and can be removed; its key then stops working", async () => {
    const { base, server } = await start({ allowOrigins: [SITE] }, {}, { ask: async () => "always" });
    const { id } = (await (await post(base, SITE)).json()) as { id: string };
    const key = (await answered(base, id, SITE)).key!;
    const list = await fetch(`${base}/api/devices?token=${server.token}`);
    const body = (await list.json()) as { devices: Record<string, unknown>[] };
    expect(body.devices).toHaveLength(1);
    expect(Object.keys(body.devices[0]!).sort()).toEqual(["createdAt", "id", "kind", "label", "lastUsed", "origin"].filter((k) => k in body.devices[0]!).sort());
    expect(JSON.stringify(body)).not.toContain(key);
    expect((await fetch(`${base}/api/devices`)).status).toBe(401);
    const gone = await fetch(`${base}/api/devices/${body.devices[0]!.id}?token=${server.token}`, { method: "DELETE" });
    expect(gone.status).toBe(204);
    expect((await fetch(`${base}/api/info`, { headers: { authorization: `Bearer ${key}` } })).status).toBe(401);
    expect((await fetch(`${base}/api/devices/${body.devices[0]!.id}?token=${server.token}`, { method: "DELETE" })).status).toBe(404);
  });
});

describe("serve --http for a program that starts it", () => {
  const MAIN = join(import.meta.dir, "../src/main.ts");
  const KEY = "canary-key-for-the-test-0123456789";

  async function launch(extra: string[]) {
    const state = tempDir();
    dirs.push(state);
    const child = Bun.spawn([process.execPath, MAIN, "serve", "--http", "--port", "0", ...extra], {
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
      env: { ...process.env, HOME: state, XDG_STATE_HOME: state, XDG_CONFIG_HOME: state, NAVVIED_SERVE_TOKEN: KEY, NAVVIED_NO_UPDATE: "1", NAVVIED_BASE_URL: "", NAVVIED_MODEL: "" },
    });
    let err = "";
    void (async () => { for await (const chunk of child.stderr as unknown as AsyncIterable<Uint8Array>) err += new TextDecoder().decode(chunk); })();
    let out = "";
    void (async () => { for await (const chunk of child.stdout as unknown as AsyncIterable<Uint8Array>) out += new TextDecoder().decode(chunk); })();
    return { child, err: () => err, out: () => out };
  }

  test("prints one ready line with the real port and nothing that holds the key, on either stream", async () => {
    const p = await launch(["--ready-line"]);
    try {
      await until(() => p.err().includes("navvied-ready"));
      const lines = p.err().split("\n").filter((l) => l.startsWith("navvied-ready"));
      expect(lines).toHaveLength(1);
      const { port } = JSON.parse(lines[0]!.slice("navvied-ready ".length)) as { port: number };
      expect(port).toBeGreaterThan(0);
      expect((await fetch(`http://127.0.0.1:${port}/api/info`)).status).toBe(401);
      expect((await fetch(`http://127.0.0.1:${port}/api/info`, { headers: { authorization: `Bearer ${KEY}` } })).status).toBe(200);
      expect(p.err()).not.toContain(KEY);
      expect(p.out()).not.toContain(KEY);
      expect(p.err()).not.toContain("listening");
    } finally { p.child.kill(); }
  });

  test("ends within two seconds when the program that started it closes its end", async () => {
    const p = await launch(["--ready-line", "--exit-when-stdin-closes"]);
    await until(() => p.err().includes("navvied-ready"));
    const at = Date.now();
    (p.child.stdin as { end(): void }).end();
    const code = await Promise.race([p.child.exited, new Promise<number>((r) => setTimeout(() => r(-1), 4000))]);
    expect(code).toBe(0);
    expect(Date.now() - at).toBeLessThan(2000);
  });

  test("without the flag it keeps running when standard input closes, and says where it listens", async () => {
    const p = await launch([]);
    try {
      await until(() => p.err().includes("navvied is listening."));
      (p.child.stdin as { end(): void }).end();
      await new Promise((r) => setTimeout(r, 400));
      expect(p.child.exitCode).toBeNull();
    } finally { p.child.kill(); }
  });
});

describe("connecting a model from a page", () => {
  const SITE = "https://beta.example";
  let service: ReturnType<typeof Bun.serve>;
  const KEY = "sk-secret-key-for-the-test-0123456789";
  beforeAll(() => {
    service = Bun.serve({ port: 0, fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/v1/models") return req.headers.get("authorization") === `Bearer ${KEY}` ? Response.json({ data: [{ id: "zeta" }, { id: "alpha" }] }) : new Response("no", { status: 401 });
      if (path === "/empty/models") return Response.json({ data: [] });
      return new Response("not found", { status: 404 });
    } });
  });
  afterAll(() => { service.stop(true); });

  const call = (base: string, token: string, path: string, body?: unknown, origin?: string) =>
    fetch(`${base}${path}?token=${token}`, { method: body === undefined ? "GET" : "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }), headers: { ...(origin ? { origin } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) } });
  const noModelEnv = { NAVVIED_BASE_URL: "", NAVVIED_MODEL: "" };

  test("only with the key", async () => {
    const { base } = await start({ allowOrigins: [SITE] }, noModelEnv);
    expect((await fetch(`${base}/api/setup`)).status).toBe(401);
    expect((await fetch(`${base}/api/setup/test`, { method: "POST", body: "{}" })).status).toBe(401);
  });

  test("shows what is on this computer and what is connected, and nothing secret", async () => {
    const { base, server } = await start({ allowOrigins: [SITE] }, noModelEnv);
    const view = (await (await call(base, server.token, "/api/setup")).json()) as { servers: unknown[]; programs: { id: string; label: string; installed: boolean }[]; models: unknown[] };
    expect(Array.isArray(view.servers)).toBe(true);
    expect(view.programs.map((p) => p.id)).toEqual(SIGN_IN_PROGRAMS.map((p) => p.id));
    expect(view.programs.every((p) => typeof p.installed === "boolean" && p.label.length > 5)).toBe(true);
    expect(view.models).toEqual([]);
  });

  test("trying a service lists its models, and says plainly what is wrong with a key or an address", async () => {
    const { base, server } = await start({ allowOrigins: [SITE] }, noModelEnv);
    const good = await (await call(base, server.token, "/api/setup/test", { baseUrl: `http://127.0.0.1:${service.port}/v1`, apiKey: KEY })).json();
    expect(good).toEqual({ ok: true, models: ["alpha", "zeta"] });
    expect(await (await call(base, server.token, "/api/setup/test", { baseUrl: `http://127.0.0.1:${service.port}/v1`, apiKey: "wrong" })).json()).toEqual({ ok: false, reason: "unauthorised" });
    expect(await (await call(base, server.token, "/api/setup/test", { baseUrl: "http://127.0.0.1:1/v1" })).json()).toEqual({ ok: false, reason: "unreachable" });
    expect(await (await call(base, server.token, "/api/setup/test", { baseUrl: "not an address" })).json()).toEqual({ ok: false, reason: "unreachable" });
    expect(await (await call(base, server.token, "/api/setup/test", { baseUrl: `http://127.0.0.1:${service.port}/empty` })).json()).toEqual({ ok: false, reason: "no-models" });
  });

  test("keeping a model writes the private file, connects at once, and the key never comes back", async () => {
    const { base, server } = await start({ allowOrigins: [SITE] }, noModelEnv);
    const saved = await (await call(base, server.token, "/api/setup/save", { baseUrl: `http://127.0.0.1:${service.port}/v1`, model: "alpha", apiKey: KEY })).text();
    expect(JSON.parse(saved)).toEqual({ ok: true, name: "alpha", connected: true });
    expect(saved).not.toContain(KEY);
    const view = await (await call(base, server.token, "/api/setup")).text();
    expect(view).not.toContain(KEY);
    expect(JSON.parse(view).models).toEqual([{ name: "alpha", label: "alpha", how: "On this computer.", current: true }]);
    const info = (await (await fetch(`${base}/api/info?token=${server.token}`)).json()) as { model: string };
    expect(info.model).toBe("alpha");
  });

  test("a second model can be added, and made the one in use afterwards", async () => {
    const { base, server } = await start({ allowOrigins: [SITE] }, noModelEnv);
    await call(base, server.token, "/api/setup/save", { baseUrl: `http://127.0.0.1:${service.port}/v1`, model: "alpha", apiKey: KEY });
    await call(base, server.token, "/api/setup/save", { baseUrl: `http://127.0.0.1:${service.port}/v1`, model: "zeta", apiKey: KEY, makeDefault: false });
    let view = (await (await call(base, server.token, "/api/setup")).json()) as { models: { name: string; current: boolean }[] };
    expect(view.models.map((m) => [m.name, m.current])).toEqual([["alpha", true], ["zeta", false]]);
    expect(await (await call(base, server.token, "/api/setup/use", { name: "zeta" })).json()).toEqual({ ok: true, name: "zeta", connected: true });
    view = (await (await call(base, server.token, "/api/setup")).json()) as typeof view;
    expect(view.models.find((m) => m.current)!.name).toBe("zeta");
    const refused = await call(base, server.token, "/api/setup/use", { name: "nope" });
    expect(refused.status).toBe(404);
  });

  test("a bad address or a missing model name is refused with a reason, and nothing is written", async () => {
    const { base, server } = await start({ allowOrigins: [SITE] }, noModelEnv);
    for (const body of [{ baseUrl: "ftp://x", model: "m" }, { baseUrl: "http://127.0.0.1:1/v1", model: "" }, {}]) {
      const res = await call(base, server.token, "/api/setup/save", body);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { ok: boolean; error: string }).error.length).toBeGreaterThan(5);
    }
    expect(((await (await call(base, server.token, "/api/setup")).json()) as { models: unknown[] }).models).toEqual([]);
    expect((await call(base, server.token, "/api/setup/save", undefined)).status).toBe(405);
    const bad = await fetch(`${base}/api/setup/save?token=${server.token}`, { method: "POST", body: "not json" });
    expect(bad.status).toBe(400);
  });

  test("a page from an allowed site gets the answer; one from another site is turned away", async () => {
    const { base, server } = await start({ allowOrigins: [SITE] }, noModelEnv);
    const ok = await call(base, server.token, "/api/setup", undefined, SITE);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("access-control-allow-origin")).toBe(SITE);
    expect((await call(base, server.token, "/api/setup", undefined, "https://evil.example")).status).toBe(403);
  });
});
