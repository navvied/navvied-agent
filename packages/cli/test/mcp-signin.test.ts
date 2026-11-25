import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OAuthStore } from "@navvied/engine";
import type { EngineEvent } from "@navvied/protocol";
import { validateCommand } from "@navvied/protocol";
import { mcpSignin } from "../src/mcp-signin.ts";
import { HOOK_MS, hook, removeTree } from "../../protocol/test/support/cleanup.ts";

const dir = mkdtempSync(join(tmpdir(), "navvied-mcp-signin-"));
afterAll(hook("mcp sign-in removes what it made", async () => { web.stop(true); await removeTree(dir); }), HOOK_MS);

let registers = true;
const web = Bun.serve({
  port: 0,
  async fetch(req) {
    const u = new URL(req.url), base = `http://${req.headers.get("host")}`;
    if (u.pathname === "/.well-known/oauth-authorization-server") return Response.json({ authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, ...(registers ? { registration_endpoint: `${base}/register` } : {}) });
    if (u.pathname === "/register") return Response.json({ client_id: "c1" }, { status: 201 });
    if (u.pathname === "/token") return Response.json({ access_token: "t", token_type: "Bearer" });
    return new Response("no", { status: 404 });
  },
});
const url = `http://127.0.0.1:${web.port}/mcp`;

const rigged = (waitMs?: number) => {
  const events: Extract<EngineEvent, { ev: "mcp.signin" | "error" }>[] = [];
  const store = new OAuthStore(join(dir, `auth-${Math.random().toString(36).slice(2)}.json`));
  const signin = mcpSignin({ inCloud: () => false, tell: (e) => { if (e.ev === "mcp.signin" || e.ev === "error") events.push(e); }, servers: () => ({ web: { url }, local: { command: "x" } }), store, ...(waitMs ? { waitMs } : {}) });
  const states = (): string[] => events.map((e) => (e.ev === "mcp.signin" ? e.state : "error"));
  const until = async (state: string): Promise<void> => { for (let i = 0; i < 500 && !states().includes(state); i++) await Bun.sleep(10); };
  return { events, store, signin, states, until };
};

describe("the sign-in of a connected program, as the host runs it", () => {
  test("the commands are checked, and others are not taken", () => {
    expect(validateCommand({ cmd: "mcp.signin", server: "web" })).toEqual({ ok: true, value: { cmd: "mcp.signin", server: "web" } });
    expect(validateCommand({ cmd: "mcp.signin.cancel", server: "web" })).toEqual({ ok: true, value: { cmd: "mcp.signin.cancel", server: "web" } });
    expect(validateCommand({ cmd: "mcp.signin" }).ok).toBe(false);
    expect(validateCommand({ cmd: "mcp.prompt", server: "a", name: "b", args: { x: "1" } }).ok).toBe(true);
    expect(validateCommand({ cmd: "mcp.prompt", server: "a", name: "b", args: { x: 1 } }).ok).toBe(false);
    expect(validateCommand({ cmd: "mcp.prompts" }).ok).toBe(true);
    expect(rigged().signin.command({ cmd: "prompts" } as never)).toBe(false);
  });

  test("waiting says the address to open; the browser coming back ends it with done, and the tokens are kept", async () => {
    const t = rigged();
    expect(t.signin.command({ cmd: "mcp.signin", server: "web" })).toBe(true);
    await t.until("waiting");
    const waiting = t.events.find((e) => e.ev === "mcp.signin" && e.state === "waiting") as Extract<EngineEvent, { ev: "mcp.signin" }>;
    expect(waiting.server).toBe("web");
    const page = new URL(waiting.url!);
    expect(page.origin).toBe(new URL(url).origin);
    await fetch(`${page.searchParams.get("redirect_uri")}?code=abc&state=${page.searchParams.get("state")}`);
    await t.until("done");
    expect(t.states()).toEqual(["waiting", "done"]);
    expect(t.store.get(url)?.access).toBe("t");
  });

  test("cancel stops the waiting", async () => {
    const t = rigged();
    t.signin.command({ cmd: "mcp.signin", server: "web" });
    await t.until("waiting");
    t.signin.command({ cmd: "mcp.signin.cancel", server: "web" });
    await t.until("stopped");
    expect(t.states()).toEqual(["waiting", "stopped"]);
  });

  test("not coming back in time, a server that cannot register us, a program that runs here and an unknown name each fail in words", async () => {
    const slow = rigged(40);
    slow.signin.command({ cmd: "mcp.signin", server: "web" });
    await slow.until("failed");
    expect(slow.events.at(-1)).toMatchObject({ state: "failed", reason: "The sign-in was not finished in time" });
    registers = false;
    const none = rigged();
    none.signin.command({ cmd: "mcp.signin", server: "web" });
    await none.until("failed");
    expect(none.events.at(-1)).toMatchObject({ state: "failed" });
    expect((none.events.at(-1) as { reason: string }).reason).toContain("oauth.clientId");
    registers = true;
    const local = rigged();
    local.signin.command({ cmd: "mcp.signin", server: "local" });
    local.signin.command({ cmd: "mcp.signin", server: "ghost" });
    await local.until("failed");
    expect(local.events.map((e) => (e as { reason?: string }).reason)).toEqual(["That program runs on this computer: it has no sign-in.", "That program is not in the configuration."]);
  });

  test("in the cloud nothing is started", () => {
    const events: EngineEvent[] = [];
    const s = mcpSignin({ inCloud: () => true, tell: (e) => events.push(e), servers: () => ({ web: { url } }), store: new OAuthStore(join(dir, "x.json")) });
    expect(s.command({ cmd: "mcp.signin", server: "web" })).toBe(true);
    expect(events).toEqual([{ ev: "error", msg: "A connected program is signed in to only on a computer, never in Navvied Cloud." }]);
  });
});
