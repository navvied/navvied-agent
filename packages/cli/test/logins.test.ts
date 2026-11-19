import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chainStore, credentialsFor, loginStoreFor } from "../src/logins.ts";
import { loadConfig } from "../src/config.ts";
import { remove, tempDir } from "./helpers.ts";

const dirs: string[] = [];
const dir = (): string => { const d = tempDir(); dirs.push(d); return d; };
afterAll(() => dirs.forEach(remove));

const saved = (exp: number): string => JSON.stringify({ claudeAiOauth: { accessToken: "access-1", refreshToken: "refresh-1", expiresAt: exp } });

describe("finding the login a program saved", () => {
  test("the first place that holds a usable login is read, and a refreshed login is written back to that place", () => {
    const memory = (text?: string) => { let t = text; return { read: () => t, write: (n: string) => { t = n; }, get now() { return t; } }; };
    const empty = memory(), junk = memory("{}"), good = memory("GOOD");
    const store = chainStore([empty, junk, good], (t) => t === "GOOD");
    expect(store.read()).toBe("GOOD");
    store.write("NEWER");
    expect(good.now).toBe("NEWER");
    expect(empty.now).toBeUndefined();
    expect(junk.now).toBe("{}");
  });
  test("the usual places: a folder named by the program's own setting, and the home folder", () => {
    const home = dir();
    mkdirSync(join(home, ".claude"));
    writeFileSync(join(home, ".claude", ".credentials.json"), saved(1));
    expect(loginStoreFor("claude", undefined, { HOME: home }, "linux").read()).toBe(saved(1));
    const other = dir();
    writeFileSync(join(other, ".credentials.json"), saved(2));
    expect(loginStoreFor("claude", undefined, { HOME: home, CLAUDE_CONFIG_DIR: other }, "linux").read()).toBe(saved(2));
    expect(loginStoreFor("chatgpt", undefined, { HOME: home }, "linux").read()).toBeUndefined();
    expect(loginStoreFor("claude", join(other, ".credentials.json"), {}, "linux").read()).toBe(saved(2));
  });
});

describe("a model that uses a sign-in", () => {
  test("its headers carry the login, and a login that is not there says what to do", async () => {
    const home = dir();
    mkdirSync(join(home, ".claude"));
    writeFileSync(join(home, ".claude", ".credentials.json"), saved(Date.now() + 3_600_000));
    const creds = credentialsFor({ provider: "claude" }, { HOME: home }, "linux")!;
    const headers = await creds.headers(new Headers());
    expect(headers.authorization).toBe("Bearer access-1");
    expect(creds.body({ system: "be brief" }).system).toBeArray();
    const none = credentialsFor({ provider: "claude" }, { HOME: dir() }, "linux")!;
    await expect(none.headers(new Headers())).rejects.toThrow("sign in");
    expect(credentialsFor({ provider: "nope" }, {}, "linux")).toBeUndefined();
  });
  test("a login near its end is refreshed and written back where it was", async () => {
    const home = dir();
    mkdirSync(join(home, ".claude"));
    const file = join(home, ".claude", ".credentials.json");
    writeFileSync(file, saved(Date.now() + 60_000));
    const asked: string[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init: RequestInit) => { asked.push(String(init.body)); return new Response(JSON.stringify({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600 })); }) as unknown as typeof fetch;
    try {
      const creds = credentialsFor({ provider: "claude" }, { HOME: home }, "linux")!;
      expect((await creds.headers(new Headers())).authorization).toBe("Bearer access-2");
    } finally { globalThis.fetch = real; }
    expect(asked[0]).toContain("refresh-1");
    expect(JSON.parse(readFileSync(file, "utf8")).claudeAiOauth).toMatchObject({ accessToken: "access-2", refreshToken: "refresh-2" });
  });
});

describe("the sign-in of a model in the configuration file", () => {
  const write = (body: unknown) => { const d = dir(); const p = join(d, "c.json"); writeFileSync(p, JSON.stringify(body)); return p; };
  test("is read, and the wrong shapes are refused in plain words", () => {
    const ok = loadConfig(write({ models: { c: { api: "messages", baseUrl: "https://api.example/v1", model: "m", signIn: { provider: "claude" } } } }));
    expect(ok.ok && ok.value?.models.c?.signIn).toEqual({ provider: "claude" });
    for (const bad of [{ signIn: { provider: "nope" } }, { signIn: "claude" }, { signIn: { provider: "claude" }, api: "chat" }]) {
      const r = loadConfig(write({ models: { c: { baseUrl: "https://api.example/v1", model: "m", api: "messages", ...bad } } }));
      expect(r.ok).toBe(false);
      expect(!r.ok && r.error).toContain("signIn");
    }
  });
});
