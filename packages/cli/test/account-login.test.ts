import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EngineEvent } from "@navvied/protocol";
import { accounts } from "../src/accounts.ts";
import { readAccount } from "../src/account.ts";
import { fakeIO, remove, tempDir, until } from "./helpers.ts";

const dirs: string[] = [];
afterAll(() => dirs.forEach(remove));

const stream = (...events: object[]): Response => new Response([": ping", ...events.map((e) => `data: ${JSON.stringify(e)}`)].map((l) => `${l}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });

type Answer = "waiting" | "lost" | "approved" | "denied" | "denied later" | "expired";

function server(o: { answers: Answer[]; unreachable?: boolean }) {
  const asked: string[] = [];
  let connections = 0;
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    asked.push(`${init?.method ?? "GET"} ${path}`);
    if (o.unreachable) throw new Error("down");
    if (path === "/api/account/device") return Response.json({ deviceCode: "dc-1", userCode: "ABCD-EFGH", verificationUrl: "https://example.test/device?code=ABCD-EFGH", expiresIn: 600, });
    if (path === "/api/account/device/token") {
      const a = o.answers[Math.min(connections++, o.answers.length - 1)]!;
      if (a === "lost") return stream();
      if (a === "waiting") return new Response(new ReadableStream<Uint8Array>({ start: (c) => { c.enqueue(new TextEncoder().encode(": ping\n\n")); init?.signal?.addEventListener("abort", () => c.error(new Error("aborted")), { once: true }); } }));
      if (a === "approved") return stream({ ev: "approved", token: "tok-secret", user: { email: "me@example.com" } });
      if (a === "denied later") return stream({ ev: "denied" });
      return new Response("", { status: a === "denied" ? 403 : 410 });
    }
    if (path === "/v1/models") return Response.json({ data: [{ id: "m1", name: "Model One" }] });
    return new Response("", { status: 204 });
  }) as unknown as typeof fetch;
  return { fetchFn, asked };
}

function page(s: ReturnType<typeof server>, o: { cloud?: boolean; signedIn?: boolean } = {}) {
  const dir = tempDir();
  dirs.push(dir);
  const paths = { account: join(dir, "account.json"), models: join(dir, "models.json"), onSignedIn: async () => { events.push("joined"); }, onSignOut: async () => { events.push("left"); } };
  const events: string[] = [];
  const told: EngineEvent[] = [];
  const io = fakeIO({ fetch: s.fetchFn }).io;
  const a = accounts({
    io, inCloud: () => !!o.cloud, account: () => readAccount(paths.account), tell: (e) => told.push(e), models: { save: () => undefined, remove: () => undefined, entries: () => ({ models: {} }) },
    session: { paths: () => paths, server: () => "https://example.test", label: () => "My computer", changed: () => { events.push("models"); }, wait: async () => undefined },
  });
  if (o.signedIn) writeSigned(paths.account);
  return { paths, events, told, send: (cmd: object) => a.command(cmd as never), of: (ev: string) => told.filter((e) => e.ev === ev) as Record<string, unknown>[] };
}

function writeSigned(file: string): void { writeFileSync(file, `${JSON.stringify({ server: "https://example.test", token: "old-token", email: "old@example.com" })}\n`); }

describe("signing in to the navvied account by a link", () => {
  test("a code is shown, and once it is approved the account is kept as /login keeps it: the file, the models, the join, then the accounts", async () => {
    const s = server({ answers: ["lost", "lost", "approved"] });
    const p = page(s);
    p.send({ cmd: "account.login" });
    await until(() => p.of("accounts").length === 1);
    const states = p.of("account.login");
    expect(states.map((e) => e.state)).toEqual(["waiting", "done"]);
    expect(states[0]).toMatchObject({ url: "https://example.test/device?code=ABCD-EFGH", code: "ABCD-EFGH" });
    expect(states[0]!.expires as number).toBeGreaterThan(Date.now());
    expect(states[1]).toMatchObject({ email: "me@example.com" });
    expect(readAccount(p.paths.account)).toEqual({ server: "https://example.test", token: "tok-secret", email: "me@example.com" });
    expect(existsSync(p.paths.models)).toBe(true);
    expect(p.events).toEqual(["joined", "models"]);
    expect((p.of("accounts")[0]!.items as { id: string; signedIn?: boolean; email?: string }[])[0]).toEqual({ id: "navvied", signedIn: true, email: "me@example.com" });
    expect(JSON.stringify(p.told)).not.toContain("tok-secret");
    expect(s.asked.filter((a) => a.includes("device/token"))).toHaveLength(3);
  });

  test("turned down, run out, and a server that cannot be reached each say so, and nothing is kept", async () => {
    for (const [answers, state] of [[["denied"], "denied"], [["denied later"], "denied"], [["expired"], "expired"]] as const) {
      const p = page(server({ answers: [...answers] }));
      p.send({ cmd: "account.login" });
      await until(() => p.of("account.login").length === 2);
      expect(p.of("account.login")[1]!.state).toBe(state);
      expect(existsSync(p.paths.account)).toBe(false);
      expect(p.of("accounts")).toHaveLength(0);
    }
    const down = page(server({ answers: ["waiting"], unreachable: true }));
    down.send({ cmd: "account.login" });
    await until(() => down.of("account.login").length === 1);
    expect(down.of("account.login")[0]).toMatchObject({ state: "failed" });
    expect(String(down.of("account.login")[0]!.error)).toContain("Could not reach");
  });

  test("stopping the wait says stopped and keeps nothing; asking again replaces the one that waits", async () => {
    const s = server({ answers: ["waiting"] });
    const p = page(s);
    const waiting = accounts({ io: fakeIO({ fetch: s.fetchFn }).io, inCloud: () => false, account: () => undefined, tell: (e) => p.told.push(e), models: { save: () => undefined, remove: () => undefined, entries: () => ({ models: {} }) }, session: { paths: () => p.paths, server: () => "https://example.test", label: () => "x", changed: () => undefined, wait: async () => undefined } });
    waiting.command({ cmd: "account.login" } as never);
    await until(() => p.of("account.login").length === 1);
    waiting.command({ cmd: "account.login.cancel" } as never);
    await until(() => p.of("account.login").length === 2);
    expect(p.of("account.login")[1]!.state).toBe("stopped");
    expect(existsSync(p.paths.account)).toBe(false);
  });
});

describe("signing out", () => {
  test("the computer leaves, the token is cancelled, the account and its models are forgotten, and the accounts say so", async () => {
    const s = server({ answers: ["waiting"] });
    const p = page(s, { signedIn: true });
    writeFileSync(p.paths.models, "{}");
    p.send({ cmd: "account.logout" });
    await until(() => p.of("accounts").length === 1);
    expect(p.events).toEqual(["left", "models"]);
    expect(s.asked).toContain("DELETE /api/account/token");
    expect(existsSync(p.paths.account)).toBe(false);
    expect(existsSync(p.paths.models)).toBe(false);
    expect((p.of("accounts")[0]!.items as { signedIn?: boolean }[])[0]!.signedIn).toBe(false);
  });

  test("signed out already is said, and nothing is asked of the server", async () => {
    const s = server({ answers: ["waiting"] });
    const p = page(s);
    p.send({ cmd: "account.logout" });
    await until(() => p.of("error").length === 1);
    expect(p.of("error")[0]!.msg).toBe("You are not signed in.");
    expect(s.asked).toEqual([]);
  });
});

describe("in Navvied Cloud", () => {
  test("all three are refused and the server is not asked", () => {
    const s = server({ answers: ["approved"] });
    const p = page(s, { cloud: true });
    for (const cmd of ["account.login", "account.login.cancel", "account.logout"]) p.send({ cmd });
    expect(p.of("error")).toHaveLength(3);
    expect(s.asked).toEqual([]);
  });
});

