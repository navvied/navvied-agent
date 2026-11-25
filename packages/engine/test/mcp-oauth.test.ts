import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OAuthStore, connectMcp, mcpSignIn } from "../src/index.ts";
import { HOOK_MS, hook, removeTree } from "../../protocol/test/support/cleanup.ts";

const dir = mkdtempSync(join(tmpdir(), "navvied-oauth-"));
afterAll(hook("oauth removes what it made", async () => { server.stop(true); await removeTree(dir); }), HOOK_MS);

/** A server that asks for a sign-in, with its own sign-in pages, on one local address. */
const issued = new Map<string, { challenge: string; redirect: string }>();
const log: string[] = [];
let access = "token-1", refresh = "refresh-1", registers = true, refreshWorks = true, expiresIn = 3600, tokenType = "Bearer";
let base = "";
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const u = new URL(req.url);
    log.push(`${req.method} ${u.pathname}`);
    const json = (body: unknown, status = 200): Response => Response.json(body, { status });
    if (u.pathname === "/.well-known/oauth-protected-resource") return json({ resource: `${base}/mcp`, authorization_servers: [base] });
    if (u.pathname === "/.well-known/oauth-authorization-server") return json({ authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, ...(registers ? { registration_endpoint: `${base}/register` } : {}), code_challenge_methods_supported: ["S256"] });
    if (u.pathname === "/register") { const body = (await req.json()) as { redirect_uris: string[] }; return json({ client_id: "client-1", redirect_uris: body.redirect_uris }, 201); }
    if (u.pathname === "/authorize") {
      expect(u.searchParams.get("code_challenge_method")).toBe("S256");
      expect(u.searchParams.get("resource")).toBe(`${base}/mcp`);
      issued.set("code-1", { challenge: u.searchParams.get("code_challenge")!, redirect: u.searchParams.get("redirect_uri")! });
      return new Response(null, { status: 302, headers: { location: `${u.searchParams.get("redirect_uri")}?code=code-1&state=${u.searchParams.get("state")}` } });
    }
    if (u.pathname === "/token") {
      const form = new URLSearchParams(await req.text());
      if (form.get("grant_type") === "refresh_token") {
        if (!refreshWorks || form.get("refresh_token") !== refresh) return json({ error: "invalid_grant", error_description: "the refresh token was revoked" }, 400);
        access = "token-2"; refresh = "refresh-2";
        return json({ access_token: access, refresh_token: refresh, token_type: "Bearer", expires_in: 3600 });
      }
      const grant = issued.get(form.get("code") ?? "");
      const ok = grant && createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url") === grant.challenge && form.get("redirect_uri") === grant.redirect && form.get("client_id") === "client-1";
      return ok ? json({ access_token: access, refresh_token: refresh, token_type: tokenType, expires_in: expiresIn }) : json({ error: "invalid_grant", error_description: "the code does not match" }, 400);
    }
    if (u.pathname === "/mcp") {
      if (req.headers.get("authorization") !== `Bearer ${access}`) return new Response("no", { status: 401, headers: { "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"` } });
      const msg = (await req.json()) as { id?: number; method: string };
      if (msg.id === undefined) return new Response(null, { status: 202 });
      const reply = (result: unknown): Response => json({ jsonrpc: "2.0", id: msg.id, result });
      if (msg.method === "initialize") return reply({ protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "fake" } });
      if (msg.method === "tools/list") return reply({ tools: [{ name: "whoami", description: "Who is signed in" }] });
      return reply({ content: [{ type: "text", text: "you are signed in" }] });
    }
    return new Response("not found", { status: 404 });
  },
});
base = `http://127.0.0.1:${server.port}`;
const url = `${base}/mcp`;
const file = join(dir, "mcp-auth.json");
let store = new OAuthStore(file);
/** The browser: opens the address the way a person's browser would, and follows where it sends it. */
const browser = async (address: string): Promise<void> => { const r = await fetch(address, { redirect: "manual" }); await fetch(r.headers.get("location")!); };

beforeEach(() => { access = "token-1"; refresh = "refresh-1"; registers = true; refreshWorks = true; expiresIn = 3600; tokenType = "Bearer"; issued.clear(); log.length = 0; store = new OAuthStore(join(dir, `auth-${Math.random().toString(36).slice(2)}.json`)); });

describe("a connected program that asks for a sign-in", () => {
  test("without a sign-in it is a problem that says so, and the others are not stopped", async () => {
    const conn = await connectMcp({ web: { url } }, false, undefined, { store });
    expect(conn.tools).toEqual([]);
    expect(conn.problems).toEqual([{ server: "web", reason: "needs a sign-in", signin: true }]);
    conn.close();
  });

  test("the sign-in registers navvied, goes through the browser with PKCE, keeps the tokens in a file only this user reads, and then the program is usable", async () => {
    const opened: string[] = [];
    await mcpSignIn({ url, store, open: async (a) => { opened.push(a); await browser(a); } });
    expect(opened).toHaveLength(1);
    const page = new URL(opened[0]!);
    expect(page.searchParams.get("client_id")).toBe("client-1");
    expect(page.searchParams.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect(log).toContain("POST /register");
    const conn = await connectMcp({ web: { url } }, false, undefined, { store });
    try {
      expect(conn.problems).toEqual([]);
      const out = await conn.tools[0]!.run({}, { cwd: dir, signal: new AbortController().signal } as never);
      expect(out).toContain("you are signed in");
    } finally { conn.close(); }
  });

  test("the file of tokens is mode 0600 and no event or error carries a token", async () => {
    const path = join(dir, "private", "auth.json");
    const own = new OAuthStore(path);
    await mcpSignIn({ url, store: own, open: browser });
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).toContain("token-1");
    registers = false;
    const failure = await mcpSignIn({ url, store: new OAuthStore(join(dir, "none.json")), open: browser }).catch((e: Error) => e.message);
    expect(String(failure)).not.toContain("token-");
  });

  test("a token that is about to run out is renewed before the call, and the new one is kept", async () => {
    expiresIn = 1;
    await mcpSignIn({ url, store, open: browser });
    expiresIn = 3600;
    const conn = await connectMcp({ web: { url } }, false, undefined, { store });
    try {
      expect(conn.problems).toEqual([]);
      expect(log).toContain("POST /token");
      expect(store.get(url)!.access).toBe("token-2");
    } finally { conn.close(); }
  });

  test("a token the server refuses is renewed once and the call goes on", async () => {
    await mcpSignIn({ url, store, open: browser });
    access = "token-2";
    const conn = await connectMcp({ web: { url } }, false, undefined, { store });
    try { expect(conn.problems).toEqual([]); expect(store.get(url)!.access).toBe("token-2"); } finally { conn.close(); }
  });

  test("when the renewal is refused too, the saved sign-in is dropped and the person is asked to sign in again", async () => {
    await mcpSignIn({ url, store, open: browser });
    access = "token-3";
    refreshWorks = false;
    const conn = await connectMcp({ web: { url } }, false, undefined, { store });
    expect(conn.problems[0]).toMatchObject({ server: "web", signin: true });
    expect(store.get(url)).toBeUndefined();
    conn.close();
  });

  test("a token in the entry's headers is used as it is: no sign-in is asked for, and a wrong one says what to check", async () => {
    const conn = await connectMcp({ web: { url, headers: { authorization: "Bearer wrong" } } }, false, undefined, { store });
    expect(conn.problems[0]!.reason).toContain("did not accept the token");
    expect(conn.problems[0]!.signin).toBeUndefined();
    conn.close();
  });
});

describe("the sign-in itself", () => {
  test("a server that cannot register navvied is asked for a client id, and one given is used", async () => {
    registers = false;
    await expect(mcpSignIn({ url, store, open: browser })).rejects.toThrow("oauth.clientId");
    await mcpSignIn({ url, store, client: { clientId: "client-1", scope: "read" }, open: async (a) => { expect(new URL(a).searchParams.get("scope")).toBe("read"); await browser(a); } });
    expect(store.get(url)!.clientId).toBe("client-1");
  });

  test("a request to the loopback address with the wrong state is ignored; the right one still finishes the sign-in", async () => {
    await mcpSignIn({ url, store, open: async (a) => {
      const redirect = new URL(a).searchParams.get("redirect_uri")!;
      expect((await fetch(`${redirect}?code=evil&state=wrong`)).status).toBe(400);
      await browser(a);
    } });
    expect(store.get(url)).toBeDefined();
  });

  test("the person stopping it, or never coming back, ends it in words and leaves nothing kept", async () => {
    const stop = new AbortController();
    const first = mcpSignIn({ url, store, signal: stop.signal, open: () => { setTimeout(() => stop.abort(), 20); } });
    await expect(first).rejects.toThrow("stopped");
    await expect(mcpSignIn({ url, store, waitMs: 50, open: () => undefined })).rejects.toThrow("not finished in time");
    expect(store.get(url)).toBeUndefined();
  });

  test("the server's refusal is told with its own words, and a kind of token that is not Bearer is refused", async () => {
    tokenType = "mac";
    await expect(mcpSignIn({ url, store, open: browser })).rejects.toThrow("not supported");
  });

  test("an address of the sign-in that is not secure is refused", async () => {
    const insecure = Bun.serve({ port: 0, fetch: (req) => (new URL(req.url).pathname.endsWith("oauth-protected-resource") ? Response.json({ authorization_servers: ["http://example.invalid"] }) : new Response("no", { status: 404 })) });
    try { await expect(mcpSignIn({ url: `http://127.0.0.1:${insecure.port}/mcp`, store, open: () => undefined })).rejects.toThrow("not secure"); } finally { insecure.stop(true); }
  });
});
