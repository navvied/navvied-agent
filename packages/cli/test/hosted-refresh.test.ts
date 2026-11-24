import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { writeAccount, writeHostedModels, type HostedModel } from "../src/account.ts";
import { createHub } from "../src/commands/hub.ts";
import { accountPath, configPath, hostedModelsPath } from "../src/config.ts";
import { fakeIO, remove, tempDir, until } from "./helpers.ts";

const dirs: string[] = [];
const hubs: { stop(): Promise<void> }[] = [];
afterAll(async () => { await Promise.all(hubs.map((h) => h.stop())); dirs.forEach(remove); });

const model = (id: string): HostedModel => ({ id, name: id.toUpperCase(), api: "chat", window: 100_000, reasoning: "none" });
type Caps = { ev: "caps"; models?: { id: string }[] };

/** A signed-in computer that last listed `before`, whose server now lists whatever `server.list` is. */
function computer(before: string[], o: { status?: number; down?: boolean } = {}) {
  const home = tempDir(), work = tempDir();
  dirs.push(home, work);
  const env = { HOME: home, XDG_STATE_HOME: home, XDG_CONFIG_HOME: home };
  mkdirSync(dirname(configPath(env)), { recursive: true });
  writeAccount(accountPath(env), { server: "https://example.test", token: "t-secret", email: "me@example.com" });
  writeHostedModels(hostedModelsPath(env), { default: before[0]!, models: before.map(model) });
  const server = { list: before, asked: 0, status: o.status ?? 200, down: !!o.down };
  const fetchFn = (async (url: string, init?: RequestInit) => {
    server.asked++;
    if (server.down) throw new Error("offline");
    expect(String(url)).toBe("https://example.test/v1/models");
    expect((init?.headers as Record<string, string>).authorization).toBe("Bearer t-secret");
    return new Response(JSON.stringify({ default: server.list[0], data: server.list.map(model) }), { status: server.status });
  }) as unknown as typeof fetch;
  const hub = createHub({ json: false, yes: false, thinking: false, cwd: work } as never, fakeIO({ env, fetch: fetchFn }).io, { watch: false });
  hubs.push(hub);
  const got: Record<string, unknown>[] = [];
  hub.attach({ send: (line) => { got.push(JSON.parse(String(line))); } }, 0);
  const ids = (): string[] => ((got.filter((e) => e.ev === "caps").at(-1) as Caps | undefined)?.models ?? []).map((m) => m.id.replace(/^navvied-/, "")).sort();
  return { env, hub, server, got, ids };
}

describe("the hosted models follow the server", () => {
  test("at the start: a list that changed on the server since the last sign-in is the list, with no sign-in", async () => {
    const c = computer(["forge", "jarvis"]);
    c.server.list = ["sage", "pulse", "apex"];
    await c.hub.refreshModels();
    // The model in use stays until another is chosen; every other one is the server's.
    await until(() => c.ids().join() === "apex,forge,pulse,sage");
    expect(JSON.parse(readFileSync(hostedModelsPath(c.env), "utf8")).models.map((m: { id: string }) => m.id)).toEqual(["sage", "pulse", "apex"]);
  });

  test("on a later ask, as after a reconnect of the relay: models added appear and models removed are gone, and the windows are told", async () => {
    const c = computer(["sage", "pulse"]);
    await until(() => c.ids().join() === "pulse,sage");
    const told = c.got.filter((e) => e.ev === "caps").length;
    c.server.list = ["sage", "apex"];
    await c.hub.refreshModels();
    await until(() => c.ids().join() === "apex,sage");
    expect(c.got.filter((e) => e.ev === "caps").length).toBeGreaterThan(told);
  });

  test("a list that did not change says nothing and writes nothing", async () => {
    const c = computer(["sage"]);
    await c.hub.refreshModels();
    const told = c.got.length;
    await c.hub.refreshModels();
    expect(c.got.length).toBe(told);
  });

  test("a server that cannot be reached, or that refuses, leaves the list that was known", async () => {
    const down = computer(["sage", "pulse"], { down: true });
    await down.hub.refreshModels();
    expect(down.ids()).toEqual(["pulse", "sage"]);
    const refused = computer(["sage"], { status: 500 });
    await refused.hub.refreshModels();
    expect(refused.ids()).toEqual(["sage"]);
  });

  test("a computer that is not signed in asks nothing", async () => {
    const home = tempDir(), work = tempDir();
    dirs.push(home, work);
    const env = { HOME: home, XDG_STATE_HOME: home, XDG_CONFIG_HOME: home };
    let asked = 0;
    const hub = createHub({ json: false, yes: false, thinking: false, cwd: work } as never, fakeIO({ env, fetch: (async () => { asked++; return new Response("{}"); }) as unknown as typeof fetch }).io, { watch: false });
    hubs.push(hub);
    await hub.refreshModels();
    expect(asked).toBe(0);
  });
});
