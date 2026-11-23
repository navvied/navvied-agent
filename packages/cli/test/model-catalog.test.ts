import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
  { id: "plus", name: "Plus", object: "model", api: "chat", window: 100000, reasoning: "none", locked: true },
] };
const AGENT = join(import.meta.dir, "../../stream-engine/test/fake-agent.ts");
const OWN = { baseUrl: "http://127.0.0.1:9/v1", model: "m", window: 8000 };

function world(config?: object) {
  const state = tempDir();
  dirs.push(state);
  const env = { HOME: state, XDG_STATE_HOME: state, XDG_CONFIG_HOME: state, NAVVIED_GUEST_MODELS: "1" };
  if (config) { mkdirSync(dirname(configPath(env)), { recursive: true }); writeFileSync(configPath(env), JSON.stringify(config)); }
  return { env, io: fakeIO({ env, fetch: (async () => Response.json(FREE)) as unknown as typeof fetch }).io };
}

async function rows(env: Record<string, string>) {
  const hub = createHub({ json: false, yes: false, thinking: false } as never, fakeIO({ env }).io, { watch: false, import: false });
  const got: { ev: string; models?: { id: string; catalog?: string; locked?: boolean; current?: boolean; handover?: boolean }[] }[] = [];
  hub.attach({ send: (line) => { got.push(JSON.parse(String(line))); } }, 0);
  await until(() => got.some((e) => e.ev === "caps"));
  const models = got.find((e) => e.ev === "caps")!.models!;
  await hub.stop();
  return models;
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
    expect(await listed(env)).toEqual({ mine: undefined, other: undefined, [`${GUEST_PREFIX}sage`]: "sage", [`${GUEST_PREFIX}ember`]: "ember", [`${GUEST_PREFIX}plus`]: "plus" });
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

describe("with a program as the current model, the computer's navvied models are still listed, by their catalogue id, with the ones not allowed marked locked", () => {
  const program = { command: "bun", args: [AGENT], window: 50000 };

  test("not signed in: the whole guest catalogue is there, the locked one is locked, and the program is the one in use", async () => {
    const { env, io } = world({ models: { prog: program }, default: "prog" });
    await ensureGuestModels(io, { json: false, yes: false, thinking: false } as never);
    const all = await rows(env);
    const byId = Object.fromEntries(all.map((m) => [m.id, m]));
    expect(all.filter((m) => m.current).map((m) => m.id)).toEqual(["prog"]);
    expect(byId[`${GUEST_PREFIX}sage`]).toMatchObject({ catalog: "sage" });
    expect(byId[`${GUEST_PREFIX}ember`]).toMatchObject({ catalog: "ember" });
    expect(byId[`${GUEST_PREFIX}plus`]).toMatchObject({ catalog: "plus", locked: true });
    expect(byId[`${GUEST_PREFIX}sage`]!.locked).toBeUndefined();
    expect(byId[`${GUEST_PREFIX}sage`]!.handover).toBe(true);
    expect(byId.prog!.handover).toBeUndefined();
  });

  test("signed in: the account's models are there with their catalogue ids, the locked one locked", async () => {
    const { env } = world({ models: { prog: program }, default: "prog" });
    writeAccount(accountPath(env), { server: "https://navvied.com", token: "nv_x", email: "a@b.c" });
    mkdirSync(dirname(hostedModelsPath(env)), { recursive: true });
    writeHostedModels(hostedModelsPath(env), { default: "sage", models: [{ id: "sage", name: "Sage", api: "chat", window: 32000, reasoning: "none" }, { id: "plus", name: "Plus", api: "chat", window: 64000, reasoning: "none", locked: true }] });
    const all = await rows(env);
    const byId = Object.fromEntries(all.map((m) => [m.id, m]));
    expect(all.filter((m) => m.current).map((m) => m.id)).toEqual(["prog"]);
    expect(byId[`${HOSTED_PREFIX}sage`]).toMatchObject({ catalog: "sage" });
    expect(byId[`${HOSTED_PREFIX}plus`]).toMatchObject({ catalog: "plus", locked: true });
  });
});
