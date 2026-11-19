import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { writeAccount } from "../src/account.ts";
import { GUEST_PREFIX } from "../src/account.ts";
import { accountPath, configPath, guestModelsPath, loadConfig } from "../src/config.ts";
import { createHub } from "../src/commands/hub.ts";
import { ensureGuestModels } from "../src/guest-models.ts";
import { PRESETS, type Screen } from "../src/presets.ts";
import { fakeIO, remove, tempDir, until } from "./helpers.ts";

const dirs: string[] = [];
afterAll(() => dirs.forEach(remove));

const LIST = { object: "list", guest: true, tokensPerDay: 10_000, default: "sage", data: [
  { id: "sage", name: "Sage", brand: "house", badge: "FREE", object: "model", api: "chat", window: 32768, reasoning: "none" },
  { id: "plus", name: "Plus", locked: true, object: "model", api: "chat", window: 100000, reasoning: "effort" },
] };

function setup(over: { fetch?: typeof fetch; config?: object; account?: boolean } = {}) {
  const state = tempDir();
  dirs.push(state);
  const env = { HOME: state, XDG_STATE_HOME: state, XDG_CONFIG_HOME: state, NAVVIED_GUEST_MODELS: "1" };
  const calls: string[] = [];
  const answer = over.fetch ?? (async (url: string | URL | Request, init?: RequestInit) => { calls.push(`${String(url)} ${(init?.headers as Record<string, string> | undefined)?.authorization ?? "no-auth"}`); return Response.json(LIST); });
  const io = fakeIO({ env, fetch: answer as typeof fetch }).io;
  if (over.config) { mkdirSync(dirname(configPath(env)), { recursive: true }); writeFileSync(configPath(env), JSON.stringify(over.config)); }
  if (over.account) writeAccount(accountPath(env), { server: "https://navvied.com", token: "nv_x", email: "a@b.c" });
  return { env, io, calls };
}

describe("the free models of navvied.com, for a computer that is not signed in", () => {
  test("they are asked of the server once, with no sign-in, kept for a day, and joined to the model list under names of their own", async () => {
    const { env, io, calls } = setup();
    await ensureGuestModels(io, { json: false, yes: false, thinking: false } as never);
    expect(calls).toEqual(["https://navvied.com/v1/models no-auth"]);
    const loaded = loadConfig(configPath(env), env);
    expect(loaded.ok).toBe(true);
    const models = (loaded as { value: { models: Record<string, { apiKey?: string; baseUrl?: string; display?: { name?: string; brand?: string; blurb?: string; locked?: boolean } }>; default?: string } }).value;
    expect(Object.keys(models.models)).toEqual([`${GUEST_PREFIX}sage`, `${GUEST_PREFIX}plus`]);
    expect(models.models[`${GUEST_PREFIX}sage`]).toMatchObject({ baseUrl: "https://navvied.com/v1", display: { name: "Sage", brand: "navvied.com (free)" } });
    expect(models.models[`${GUEST_PREFIX}sage`]!.apiKey).toBeUndefined();
    expect(models.models[`${GUEST_PREFIX}sage`]!.display!.blurb).toContain("10,000 tokens a day");
    expect(models.models[`${GUEST_PREFIX}plus`]!.display!.locked).toBe(true);
    // Offered, not chosen: nothing is sent to navvied.com unless the person picks one.
    expect(models.default).toBeUndefined();
    // Fresh enough: not asked again. A day later: asked again.
    await ensureGuestModels(io, { json: false, yes: false, thinking: false } as never);
    expect(calls.length).toBe(1);
    const old = new Date(Date.now() - 2 * 86_400_000);
    utimesSync(guestModelsPath(env), old, old);
    await ensureGuestModels(io, { json: false, yes: false, thinking: false } as never);
    expect(calls.length).toBe(2);
  });

  test("nothing is asked when the person is signed in, turned it off, chose a model by environment, or runs in a sandbox; a server that is down changes nothing", async () => {
    const opts = { json: false, yes: false, thinking: false } as never;
    for (const s of [setup({ account: true }), setup({ config: { models: {}, guestModels: false } })]) { await ensureGuestModels(s.io, opts); expect(s.calls).toEqual([]); }
    const env = setup(); env.io.env.NAVVIED_BASE_URL = "http://x"; await ensureGuestModels(env.io, opts); expect(env.calls).toEqual([]);
    const box = setup(); await ensureGuestModels(box.io, { ...(opts as object), sandboxed: true } as never); expect(box.calls).toEqual([]);
    const down = setup({ fetch: (async () => { throw new Error("offline"); }) as unknown as typeof fetch });
    await ensureGuestModels(down.io, opts);
    const loaded = loadConfig(configPath(down.env), down.env);
    expect(loaded.ok && loaded.value).toBeNull();
    // A server that does not say it is for guests is not believed.
    const odd = setup({ fetch: (async () => Response.json({ data: [] })) as unknown as typeof fetch });
    await ensureGuestModels(odd.io, opts);
    expect(loadConfig(configPath(odd.env), odd.env)).toEqual({ ok: true, value: null });
  });

  test("a computer's own models and the free ones are both offered, and a hub announces both", async () => {
    const { env, io } = setup({ config: { models: { mine: { baseUrl: "http://127.0.0.1:9/v1", model: "m", window: 8000 }, other: { baseUrl: "http://127.0.0.1:9/v1", model: "o", window: 8000 } }, default: "mine" } });
    await ensureGuestModels(io, { json: false, yes: false, thinking: false } as never);
    const hub = createHub({ json: false, yes: false, thinking: false } as never, fakeIO({ env }).io, { watch: false, import: false });
    const got: { ev: string; models?: { id: string }[] }[] = [];
    hub.attach({ send: (line) => { got.push(JSON.parse(String(line))); } }, 0);
    await until(() => got.some((e) => e.ev === "caps"));
    const ids = got.find((e) => e.ev === "caps")!.models!.map((m) => m.id);
    expect(ids).toEqual(expect.arrayContaining(["mine", "other", `${GUEST_PREFIX}sage`]));
    await hub.stop();
  });

  test("a first run offers the free models as a choice: the person picks one and only then is it the model; with none on offer it says so", async () => {
    const free = PRESETS.find((p) => p.label === "The free models of navvied.com")!;
    const { env } = setup();
    const said: string[] = [];
    const screen = (fetch: typeof globalThis.fetch, pick: number): Screen => ({
      io: { env, fetch } as never, sys: {} as never, local: [],
      pick: async () => pick, secret: async () => "back", ask: async () => "", askOrBack: async () => "back",
      say: (t) => { said.push(t); },
      work: async (_t, _p, task) => task({ signal: new AbortController().signal, log: () => undefined }),
    });
    const answer = async () => Response.json(LIST);
    const made = await free.configure(screen(answer as never, 0));
    expect(made).not.toBe("back");
    const { name, entry } = made as { name: string; entry: { baseUrl?: string; apiKey?: string; display?: { name?: string } } };
    expect(name).toBe(`${GUEST_PREFIX}sage`);
    expect(entry).toMatchObject({ baseUrl: "https://navvied.com/v1", display: { name: "Sage" } });
    expect(entry.apiKey).toBeUndefined();
    const none = await free.configure(screen((async () => Response.json({ ...LIST, data: LIST.data.map((m) => ({ ...m, locked: true })) })) as never, 0));
    expect(none).toBe("back");
    expect(said.at(-1)).toContain("did not offer free models");
  });
});

