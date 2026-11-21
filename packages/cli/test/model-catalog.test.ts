import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { GUEST_PREFIX, HOSTED_PREFIX, writeAccount, writeHostedModels } from "../src/account.ts";
import { createHub } from "../src/commands/hub.ts";
import { accountPath, configPath, hostedModelsPath } from "../src/config.ts";
import { ensureGuestModels } from "../src/guest-models.ts";
import { fakeIO, remove, tempDir, until } from "./helpers.ts";

const dirs: string[] = [];
afterAll(() => dirs.forEach(remove));

const FREE = { object: "list", guest: true, tokensPerDay: 10_000, default: "sage", data: [
  { id: "sage", name: "Sage", brand: "house", badge: "FREE", object: "model", api: "chat", window: 32768, reasoning: "none" },
  { id: "ember", name: "Ember", object: "model", api: "chat", window: 32768, reasoning: "none" },
] };
const OWN = { baseUrl: "http://127.0.0.1:9/v1", model: "m", window: 8000 };

function world(config?: object) {
  const state = tempDir();
  dirs.push(state);
  const env = { HOME: state, XDG_STATE_HOME: state, XDG_CONFIG_HOME: state, NAVVIED_GUEST_MODELS: "1" };
  if (config) { mkdirSync(dirname(configPath(env)), { recursive: true }); writeFileSync(configPath(env), JSON.stringify(config)); }
  return { env, io: fakeIO({ env, fetch: (async () => Response.json(FREE)) as unknown as typeof fetch }).io };
}

async function listed(env: Record<string, string>) {
  const hub = createHub({ json: false, yes: false, thinking: false } as never, fakeIO({ env }).io, { watch: false, import: false });
  const got: { ev: string; models?: { id: string; catalog?: string }[] }[] = [];
  hub.attach({ send: (line) => { got.push(JSON.parse(String(line))); } }, 0);
  await until(() => got.some((e) => e.ev === "caps"));
  const models = got.find((e) => e.ev === "caps")!.models!;
  await hub.stop();
  return Object.fromEntries(models.map((m) => [m.id, m.catalog]));
}

describe("a computer's engine says which of its models are navvied.com's own, by the id the site's catalogue gives them", () => {
  test("a guest: the free models carry the catalogue id, the computer's own models carry none", async () => {
    const { env, io } = world({ models: { mine: OWN, other: OWN }, default: "mine" });
    await ensureGuestModels(io, { json: false, yes: false, thinking: false } as never);
    expect(await listed(env)).toEqual({ mine: undefined, other: undefined, [`${GUEST_PREFIX}sage`]: "sage", [`${GUEST_PREFIX}ember`]: "ember" });
  });

  test("signed in: the account's models carry the catalogue id, which is not the name this engine gives the entry", async () => {
    const { env } = world({ models: { mine: OWN }, default: "mine" });
    writeAccount(accountPath(env), { server: "https://navvied.com", token: "nv_x", email: "a@b.c" });
    mkdirSync(dirname(hostedModelsPath(env)), { recursive: true });
    writeHostedModels(hostedModelsPath(env), { default: "sage", models: [{ id: "sage", name: "Sage", api: "chat", window: 32000, reasoning: "none" }, { id: "apex", name: "Apex", api: "messages", window: 200000, reasoning: "effort" }] });
    const ids = await listed(env);
    expect(ids).toEqual({ mine: undefined, [`${HOSTED_PREFIX}sage`]: "sage", [`${HOSTED_PREFIX}apex`]: "apex" });
    expect(Object.keys(ids)).not.toContain("sage");
  });

  test("a free-model entry saved by an earlier version, with no catalogue id, is told by its name and its address; a computer's own entry that only looks like one is not", async () => {
    const saved = { baseUrl: "https://navvied.com/v1", model: "sage", window: 32768 };
    const { env } = world({ models: { [`${GUEST_PREFIX}sage`]: saved, [`${GUEST_PREFIX}fake`]: OWN, mine: OWN }, default: "mine" });
    expect(await listed(env)).toEqual({ [`${GUEST_PREFIX}sage`]: "sage", [`${GUEST_PREFIX}fake`]: undefined, mine: undefined });
  });
});
