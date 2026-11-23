import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHub } from "../src/commands/hub.ts";
import { configPath, loadConfig, resolveModel } from "../src/config.ts";
import { PROVIDERS } from "../src/presets.ts";
import { redact } from "../../engine/src/redact.ts";
import { secretsOf } from "../src/create.ts";
import { baseOf, headersOf, listModels, mergeSaved, modelEntryOf, reportOf, savedSecrets, type ProviderEntry } from "../src/providers.ts";
import { fakeIO, remove, tempDir, until } from "./helpers.ts";

const dirs: string[] = [];
afterAll(() => { dirs.forEach(remove); });
const entry = (id: string): ProviderEntry => PROVIDERS.find((p) => p.id === id)!;
/** A provider with a field that is sent as a header (an organisation) and one that is not. */
const withOrg = PROVIDERS.find((p) => p.fields?.some((f) => f.id === "org" && f.header) && p.fields.some((f) => f.id === "project"))!;

describe("the catalogue", () => {
  test("every id is there once, an address is an address, every {placeholder} is a field", () => {
    const ids = PROVIDERS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of PROVIDERS) {
      const bases = p.regions ? p.regions.map((r) => r.base) : [p.base ?? ""];
      for (const b of bases) {
        expect(b, p.id).toMatch(/^https?:\/\//);
        for (const [, name] of b.matchAll(/\{(\w+)\}/g)) expect(p.fields?.some((f) => f.id === name), `${p.id} {${name}}`).toBe(true);
      }
      expect(!!p.regions !== !!p.base, `${p.id}: one of base and regions`).toBe(true);
    }
  });
});

describe("what a provider needs becomes an entry of the configuration", () => {
  test("a bearer provider: the key travels as the key, the address is its own", () => {
    const made = modelEntryOf(entry("deepseek"), { key: "k1" }, "m");
    expect(made).toEqual({ entry: { baseUrl: "https://api.deepseek.com", model: "m", apiKey: "k1" } });
  });

  test("a provider that wants another header gets the key in it and nowhere else", () => {
    const made = modelEntryOf(entry("azure"), { key: "k2", fields: { resource: "my res" } }, "dep") as { entry: { baseUrl: string; apiKey?: string; headers?: Record<string, string> } };
    expect(made.entry.baseUrl).toBe(entry("azure").base!.replace("{resource}", "my%20res"));
    expect(made.entry.headers).toEqual({ "api-key": "k2" });
    expect(made.entry.apiKey).toBeUndefined();
  });

  test("a field that is a header is sent as that header, and only when it has a value", () => {
    const header = withOrg.fields!.find((f) => f.id === "org")!.header!;
    expect(headersOf(withOrg, { key: "k", fields: { org: "org-1" } })).toEqual({ [header]: "org-1" });
    expect(headersOf(withOrg, { key: "k" })).toEqual({});
  });

  test("a region picks the address, and without one there is no address", () => {
    expect(baseOf(entry("kimi"), { key: "k", region: "cn" })).toEqual({ base: "https://api.moonshot.cn/v1" });
    expect(baseOf(entry("kimi"), { key: "k" })).toEqual({ missing: "a region" });
    expect(modelEntryOf(entry("azure"), { key: "k" }, "m")).toEqual({ missing: "Resource name" });
  });

  test("a key is needed unless the provider says it is not", () => {
    expect(modelEntryOf(entry("deepseek"), {}, "m")).toEqual({ missing: "a key" });
    expect("entry" in modelEntryOf(entry("lmstudio"), {}, "m")).toBe(true);
  });
});

describe("what is said about what is saved", () => {
  test("it says a key is there and the fields that are not secret, never the key", () => {
    const e: ProviderEntry = { id: "x", name: "X", base: "https://x.test", fields: [{ id: "a", label: "A" }, { id: "s", label: "S", secret: true }] };
    const said = reportOf([e], { x: { key: "KEY-123", region: "r", fields: { a: "1", s: "SECRET-456" } }, other: { key: "nope" } });
    expect(said).toEqual([{ id: "x", key: true, region: "r", fields: { a: "1" } }]);
    expect(JSON.stringify(said)).not.toMatch(/KEY-123|SECRET-456|nope/);
  });

  test("saving keeps the key when none is sent, takes a field away when it is sent empty, and refuses what the provider does not have", () => {
    const e = withOrg;
    const first = mergeSaved(e, undefined, { key: "k", fields: { org: "o", project: "p" } }) as { saved: unknown };
    expect(first.saved).toEqual({ key: "k", fields: { org: "o", project: "p" } });
    expect((mergeSaved(e, first.saved as never, { fields: { org: "" } }) as { saved: unknown }).saved).toEqual({ key: "k", fields: { project: "p" } });
    expect(mergeSaved(e, undefined, { fields: { nope: "1" } })).toEqual({ error: `${e.name} has no field nope` });
    expect(mergeSaved(e, undefined, { region: "eu" })).toEqual({ error: `${e.name} has no region eu` });
  });
});

/** What a computer says about the providers that take a key (the one that signs in with a file is always there, and has its own tests). */
const keyed = (items: unknown[] | undefined): unknown[] => (items ?? []).filter((i) => (i as { id: string }).id !== PROVIDERS.find((p) => p.adc)!.id);

/** A provider that answers every list request with one model, so that saving a key never reaches a real service. */
const listing: typeof fetch = (async () => Response.json({ data: [{ id: "m" }] })) as unknown as typeof fetch;

function computer(cloud: false | "config" | "flag" = false, fetchFn?: typeof fetch, extraEnv: Record<string, string> = {}) {
  const state = tempDir(), work = tempDir();
  dirs.push(state, work);
  const env = { HOME: state, XDG_STATE_HOME: state, XDG_CONFIG_HOME: state, NAVVIED_GUEST_MODELS: "0", ...extraEnv };
  const file = configPath(env);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ models: { m: { baseUrl: "http://127.0.0.1:1/v1", model: "x", apiKey: "k", window: 1000 } }, ...(cloud === "config" ? { webProxy: { url: "http://127.0.0.1:1/v1/web", token: "t" } } : {}) }));
  const hub = createHub({ json: false, yes: false, thinking: false, cwd: work, ...(cloud === "flag" ? { sandboxed: true } : {}) } as never, fakeIO({ env, fetch: fetchFn ?? listing }).io, { watch: false, import: false });
  const got: { ev: string; msg?: string; items?: unknown[]; models?: string[]; id?: string }[] = [];
  hub.attach({ send: (line) => { got.push(JSON.parse(String(line))); } }, 0);
  const send = (cmd: object): void => hub.command(JSON.stringify(cmd), () => undefined);
  const said = (ev: string) => got.filter((e) => e.ev === ev);
  return { file, send, said, got };
}

describe("a computer keeps what a person gives a provider, and says only what is safe to say", () => {
  test("saved: one list entry that says a key is there, the file is private, the key is nowhere in what was said", async () => {
    const c = computer();
    c.send({ cmd: "provider.save", id: "kimi", key: "sk-secret-1", region: "intl" });
    await until(() => c.said("providers").length === 1);
    expect(keyed(c.said("providers")[0]!.items)).toEqual([{ id: "kimi", key: true, region: "intl" }]);
    expect(JSON.stringify(c.said("providers"))).not.toContain("sk-secret-1");
    expect(JSON.parse(readFileSync(c.file, "utf8")).providers.kimi).toEqual({ key: "sk-secret-1", region: "intl" });
    if (process.platform !== "win32") expect(statSync(c.file).mode & 0o777).toBe(0o600);
    c.send({ cmd: "provider.save", id: "kimi", region: "cn" });
    await until(() => c.said("providers").length === 2);
    expect(JSON.parse(readFileSync(c.file, "utf8")).providers.kimi).toEqual({ key: "sk-secret-1", region: "cn" });
  });

  test("asked, it answers with what is saved; removed, nothing is left", async () => {
    const c = computer();
    c.send({ cmd: "provider.save", id: "deepseek", key: "k" });
    await until(() => c.said("providers").length === 1);
    c.send({ cmd: "providers" });
    await until(() => c.said("providers").length === 2);
    expect(keyed(c.said("providers")[1]!.items)).toEqual([{ id: "deepseek", key: true }]);
    c.send({ cmd: "provider.remove", id: "deepseek" });
    await until(() => c.said("providers").length === 3);
    expect(keyed(c.said("providers")[2]!.items)).toEqual([]);
    expect(JSON.parse(readFileSync(c.file, "utf8")).providers).toBeUndefined();
  });

  test("an unknown provider, a field it does not have and a session in Navvied Cloud are refused, and nothing is written", async () => {
    const c = computer();
    c.send({ cmd: "provider.save", id: "nobody", key: "k" });
    c.send({ cmd: "provider.save", id: "deepseek", key: "k", fields: { nope: "1" } });
    await until(() => c.said("error").length === 2);
    for (const how of ["config", "flag"] as const) {
      const cloud = computer(how);
      const before = readFileSync(cloud.file, "utf8");
      cloud.send({ cmd: "provider.save", id: "deepseek", key: "sk-in-the-cloud" });
      await until(() => cloud.said("error").length === 1);
      expect(cloud.said("error")[0]!.msg).toContain("never in Navvied Cloud");
      expect(readFileSync(cloud.file, "utf8")).toBe(before);
    }
    expect(existsSync(c.file) && readFileSync(c.file, "utf8")).not.toContain('"providers"');
  });
});

describe("a saved provider lists its models and becomes one of the person's models", () => {
  const listing = (seen: { url: string; headers: Record<string, string> }[]): typeof fetch => (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    return new Response(JSON.stringify({ data: [{ id: "zeta" }, { id: "alpha" }] }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  test("its models are asked for at its own address with the saved key, and come back sorted; without a key nothing is asked", async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const c = computer(false, listing(seen));
    c.send({ cmd: "provider.models", id: "deepseek" });
    await until(() => c.said("error").length === 1);
    expect(seen).toEqual([]);
    c.send({ cmd: "provider.save", id: "deepseek", key: "sk-list" });
    await until(() => c.said("providers").length === 1);
    c.send({ cmd: "provider.models", id: "deepseek" });
    await until(() => c.said("provider.models").length === 1);
    expect(c.said("provider.models")[0]).toMatchObject({ id: "deepseek", models: ["alpha", "zeta"] });
    expect(seen).toHaveLength(2);
    expect(seen.map((x) => x.url)).toEqual([`${entry("deepseek").base}/models`, `${entry("deepseek").base}/models`]);
    expect(seen.map((x) => x.headers.authorization)).toEqual(["Bearer sk-list", "Bearer sk-list"]);
    expect(JSON.stringify(c.got)).not.toContain("sk-list");
  });

  test("using a model writes one entry to the configuration and hands the conversation over to it", async () => {
    const c = computer();
    c.send({ cmd: "provider.save", id: "deepseek", key: "sk-use" });
    await until(() => c.said("providers").length === 1);
    c.send({ cmd: "provider.use", id: "deepseek", model: "Big Model.v2".replace(" ", "-") });
    await until(() => c.said("notice").length === 1);
    const config = JSON.parse(readFileSync(c.file, "utf8"));
    expect(config.models["deepseek-big-model.v2"]).toEqual({ provider: "deepseek", model: "Big-Model.v2", window: 128000, display: { name: "Big-Model.v2", brand: entry("deepseek").name } });
    expect(JSON.stringify(config.models)).not.toContain("sk-use");
    expect((c.said("caps") as unknown as { models: { id: string }[] }[]).some((e) => e.models.some((m) => m.id === "deepseek-big-model.v2"))).toBe(true);
    expect(c.said("notice")[0]!.msg).toContain("The conversation so far goes with it.");
  });

  test("a provider that needs a region or a field is not used before they are there", async () => {
    const c = computer();
    c.send({ cmd: "provider.save", id: "kimi", key: "k" });
    await until(() => c.said("providers").length === 1);
    c.send({ cmd: "provider.use", id: "kimi", model: "m" });
    await until(() => c.said("error").length === 1);
    expect(JSON.parse(readFileSync(c.file, "utf8")).models["kimi-m"]).toBeUndefined();
  });
});

describe("a provider whose list names a route for each model", () => {
  const routed = PROVIDERS.find((p) => p.routes && p.sessionHeader)!;
  const api = (protocol: string, base: string): Record<string, { base_url: string }> => ({ [protocol]: { base_url: base } });
  const list = {
    data: [
      { id: "m-chat", recommended_api: "chat-completions", api: api("chat-completions", "https://x.test/chat/v1") },
      { id: "m-resp", recommended_api: "responses", api: api("responses", "https://x.test/chat/v1/") },
      { id: "m-msg", recommended_api: "messages", api: api("messages", "https://x.test/msg/v1") },
      { id: "m-both", recommended_api: "responses", api: { ...api("chat-completions", "https://x.test/c"), ...api("responses", "https://x.test/r") } },
      { id: "m-first", api: { ...api("responses", "https://x.test/r"), ...api("chat-completions", "https://x.test/c") } },
      { id: "m-gen", recommended_api: "interactions", api: { ...api("generate-content", "https://x.test/g"), ...api("interactions", "https://x.test/g") } },
      { id: "m-embed", api: api("embeddings", "https://x.test/chat/v1") },
      { id: "m-none" },
    ],
  };
  const fetchFn = ((): typeof fetch => (async () => Response.json(list)) as unknown as typeof fetch)();

  test("each model takes the route the list gives it (the recommended one when it is spoken), and a model no spoken route reaches is left out with the reason", async () => {
    const got = await listModels(routed, "https://x.test/chat/v1", {}, fetchFn);
    if ("error" in got) throw new Error(got.error);
    expect(Object.fromEntries(got.models.map((m) => [m.id, m.route]))).toEqual({
      "m-chat": { api: "chat", base: "https://x.test/chat/v1" },
      "m-resp": { api: "responses", base: "https://x.test/chat/v1" },
      "m-msg": { api: "messages", base: "https://x.test/msg/v1" },
      "m-both": { api: "responses", base: "https://x.test/r" },
      "m-first": { api: "chat", base: "https://x.test/c" },
    });
    expect(got.skipped).toEqual([
      { id: "m-embed", reason: "it is reached through embeddings, which this program does not speak" },
      { id: "m-gen", reason: "it is reached through generate-content, interactions, which this program does not speak" },
      { id: "m-none", reason: "the provider lists no route for it" },
    ]);
  });

  test("a provider without routes lists plain names and skips nothing", async () => {
    const got = await listModels(entry("deepseek"), "https://x.test/v1", {}, fetchFn);
    if ("error" in got) throw new Error(got.error);
    expect(got.models.map((m) => m.id)).toContain("m-gen");
    expect(got.models.every((m) => m.route === undefined) && got.skipped).toEqual([]);
  });

  test("using a model writes its own route, and the session header the provider asks for is made once and kept with the model", async () => {
    const saved = { key: "sk-r" };
    const made = modelEntryOf(routed, saved, "m-msg", { api: "messages", base: "https://x.test/msg/v1" }, "sess-1") as { entry: { baseUrl: string; api?: string; headers?: Record<string, string>; apiKey?: string } };
    expect(made.entry).toMatchObject({ baseUrl: "https://x.test/msg/v1", api: "messages", apiKey: "sk-r", headers: { [routed.sessionHeader!]: "sess-1" } });
    const again = modelEntryOf(routed, saved, "m-chat", { api: "chat", base: "https://x.test/chat/v1" }) as { entry: { headers?: unknown } };
    expect(again.entry.headers).toBeUndefined();
  });

  test("through the hub: the models come with the skipped ones and their reasons; a skipped or unknown model is refused; a listed one is written with its route", async () => {
    const c = computer(false, fetchFn);
    c.send({ cmd: "provider.save", id: routed.id, key: "sk-hub" });
    await until(() => c.said("providers").length === 1);
    c.send({ cmd: "provider.models", id: routed.id });
    await until(() => c.said("provider.models").length === 1);
    const said = c.said("provider.models")[0] as unknown as { models: string[]; skipped: { id: string }[] };
    expect(said.models).toEqual(["m-both", "m-chat", "m-first", "m-msg", "m-resp"]);
    expect(said.skipped.map((m) => m.id)).toEqual(["m-embed", "m-gen", "m-none"]);
    c.send({ cmd: "provider.use", id: routed.id, model: "m-gen" });
    c.send({ cmd: "provider.use", id: routed.id, model: "nope" });
    await until(() => c.said("error").length === 2);
    expect(c.said("error").map((e) => e.msg)).toEqual(["m-gen: it is reached through generate-content, interactions, which this program does not speak.", `${routed.name} does not list nope.`]);
    c.send({ cmd: "provider.use", id: routed.id, model: "m-msg" });
    await until(() => c.said("notice").length === 1);
    const written = JSON.parse(readFileSync(c.file, "utf8")).models[`${routed.id}-m-msg`];
    expect(written).toMatchObject({ provider: routed.id, model: "m-msg", route: { api: "messages", base: "https://x.test/msg/v1" } });
    expect(written.session).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(written)).not.toContain("sk-hub");
    const now = loadConfig(c.file);
    if (!now.ok) throw new Error(now.error);
    const resolved = resolveModel(`${routed.id}-m-msg`, now.value, {}, c.file);
    if (!resolved.ok) throw new Error(resolved.error);
    expect(resolved.value).toMatchObject({ api: "messages", provider: { baseUrl: "https://x.test/msg/v1", model: "m-msg", apiKey: "sk-hub", headers: { [routed.sessionHeader!]: written.session } } });
  });
});

describe("a provider that signs in with a credential file of the computer", () => {
  const adcEntry = PROVIDERS.find((p) => p.adc)!;
  const SECRET = "sk-must-never-be-copied";
  const credentialFile = (): string => { const d = tempDir(); dirs.push(d); const f = join(d, "adc.json"); writeFileSync(f, JSON.stringify({ type: "authorized_user", client_id: "id", client_secret: SECRET, refresh_token: `${SECRET}-r` })); return f; };

  test("it takes no key, says whether a credential file was found, and its fields are saved like any other", async () => {
    const c = computer(false, undefined, { [adcEntry.adc!.env]: credentialFile() });
    c.send({ cmd: "provider.save", id: adcEntry.id, key: "sk-nope" });
    await until(() => c.said("error").length === 1);
    expect(c.said("error")[0]!.msg).toContain("takes no key");
    c.send({ cmd: "provider.save", id: adcEntry.id, fields: { project: "p-1", location: "global" } });
    await until(() => c.said("providers").length === 1);
    expect(c.said("providers")[0]!.items).toEqual([{ id: adcEntry.id, key: false, credential: true, fields: { project: "p-1", location: "global" } }]);
    const none = computer();
    none.send({ cmd: "providers" });
    await until(() => none.said("providers").length === 1);
    expect(none.said("providers")[0]!.items).toEqual([{ id: adcEntry.id, key: false, credential: false }]);
  });

  test("using a model writes the path of the file and the address with the project and place, never what the file holds", async () => {
    const file = credentialFile();
    const c = computer(false, undefined, { [adcEntry.adc!.env]: file });
    c.send({ cmd: "provider.save", id: adcEntry.id, fields: { project: "my project", location: "eu-west1" } });
    await until(() => c.said("providers").length === 1);
    c.send({ cmd: "provider.use", id: adcEntry.id, model: "vendor/model-1" });
    await until(() => c.said("notice").length === 1);
    const text = readFileSync(c.file, "utf8");
    const written = JSON.parse(text).models[`${adcEntry.id}-vendor-model-1`];
    expect(written).toMatchObject({ provider: adcEntry.id, model: "vendor/model-1", credential: file });
    expect(written.apiKey).toBeUndefined();
    const now = loadConfig(c.file);
    if (!now.ok) throw new Error(now.error);
    const resolved = resolveModel(`${adcEntry.id}-vendor-model-1`, now.value, {}, c.file);
    if (!resolved.ok) throw new Error(resolved.error);
    expect(resolved.value).toMatchObject({ provider: { baseUrl: adcEntry.base!.replace("{project}", "my%20project").replace("{location}", "eu-west1"), model: "vendor/model-1" }, adc: { file, tokenUri: adcEntry.adc!.tokenUri, scope: adcEntry.adc!.scope } });
    expect(text).not.toContain(SECRET);
    expect(JSON.stringify(c.got)).not.toContain(SECRET);
  });

  test("without a usable credential file, or without its fields, no model is written and the reason is said; there is no list of models to ask for", async () => {
    const c = computer();
    c.send({ cmd: "provider.save", id: adcEntry.id, fields: { project: "p", location: "global" } });
    await until(() => c.said("providers").length === 1);
    c.send({ cmd: "provider.use", id: adcEntry.id, model: "m" });
    c.send({ cmd: "provider.models", id: adcEntry.id });
    await until(() => c.said("error").length === 2);
    expect(c.said("error").map((e) => e.msg)).toEqual(["No credential file was found on this computer.", `${adcEntry.name} has no list of models here: give the name of the model.`]);
    const bad = tempDir(); dirs.push(bad);
    const odd = join(bad, "odd.json"); writeFileSync(odd, JSON.stringify({ type: "external_account", audience: "x" }));
    const d = computer(false, undefined, { [adcEntry.adc!.env]: odd });
    d.send({ cmd: "provider.save", id: adcEntry.id, fields: { project: "p", location: "global" } });
    await until(() => d.said("providers").length === 1);
    d.send({ cmd: "provider.use", id: adcEntry.id, model: "m" });
    await until(() => d.said("error").length === 1);
    expect(d.said("error")[0]!.msg).toBe("The credential file is of a kind this program does not read (external_account).");
    expect(JSON.parse(readFileSync(d.file, "utf8")).models[`${adcEntry.id}-m`]).toBeUndefined();
    const lacking = computer(false, undefined, { [adcEntry.adc!.env]: credentialFile() });
    lacking.send({ cmd: "provider.use", id: adcEntry.id, model: "m" });
    await until(() => lacking.said("error").length === 1);
    expect(lacking.said("error")[0]!.msg).toBe(`Add Project ID for ${adcEntry.name} first.`);
  });

  test("in Navvied Cloud it is refused like every provider", async () => {
    const cloud = computer("flag", undefined, { [adcEntry.adc!.env]: credentialFile() });
    cloud.send({ cmd: "provider.use", id: adcEntry.id, model: "m" });
    await until(() => cloud.said("error").length === 1);
    expect(cloud.said("error")[0]!.msg).toContain("never in Navvied Cloud");
  });
});

describe("a key is tried on the provider's own list of models before it is kept", () => {
  const answer = (status: number): typeof fetch => (async () => new Response(status === 200 ? JSON.stringify({ data: [{ id: "m" }] }) : "", { status })) as unknown as typeof fetch;
  const down: typeof fetch = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;

  test("a key the provider refuses is not saved, the file is as it was, and the answer is the error", async () => {
    for (const status of [401, 403]) {
      const c = computer(false, answer(status));
      const before = readFileSync(c.file, "utf8");
      c.send({ cmd: "provider.save", id: "deepseek", key: "sk-wrong" });
      await until(() => c.said("error").length === 1);
      expect(c.said("error")[0]!.msg).toBe("The provider did not accept the key.");
      expect(c.said("providers")).toEqual([]);
      expect(readFileSync(c.file, "utf8")).toBe(before);
    }
  });

  test("a key it accepts is saved; a provider that cannot be asked, or has no list, still saves, and only the first says it could not check", async () => {
    const good = computer(false, answer(200));
    good.send({ cmd: "provider.save", id: "deepseek", key: "sk-right" });
    await until(() => good.said("providers").length === 1);
    expect(good.said("notice")).toEqual([]);
    expect(JSON.parse(readFileSync(good.file, "utf8")).providers.deepseek.key).toBe("sk-right");

    for (const how of [down, answer(500)]) {
      const c = computer(false, how);
      c.send({ cmd: "provider.save", id: "deepseek", key: "sk-unchecked" });
      await until(() => c.said("providers").length === 1);
      expect(c.said("notice").map((n) => n.msg)).toHaveLength(1);
      expect(c.said("notice")[0]!.msg).toMatch(/The key is saved, but it was not checked\.$/);
      expect(JSON.parse(readFileSync(c.file, "utf8")).providers.deepseek.key).toBe("sk-unchecked");
    }
    const none = computer(false, answer(404));
    none.send({ cmd: "provider.save", id: "deepseek", key: "sk-nolist" });
    await until(() => none.said("providers").length === 1);
    expect(none.said("notice")).toEqual([]);
  });

  test("a change that carries no key is not tried, and a provider that signs in with a file is not asked at all", async () => {
    let asked = 0;
    const counting = (async () => { asked++; return new Response("", { status: 401 }); }) as unknown as typeof fetch;
    const c = computer(false, counting);
    c.send({ cmd: "provider.save", id: "kimi", region: "intl" });
    c.send({ cmd: "provider.save", id: PROVIDERS.find((p) => p.adc)!.id, fields: { project: "p", location: "global" } });
    await until(() => c.said("providers").length === 2);
    expect(asked).toBe(0);
  });

  test("a key saved with its region is tried at that region's address", async () => {
    const seen: string[] = [];
    const c = computer(false, (async (url: string) => { seen.push(url); return new Response(JSON.stringify({ data: [{ id: "m" }] })); }) as unknown as typeof fetch);
    c.send({ cmd: "provider.save", id: "kimi", key: "sk-r", region: "cn" });
    await until(() => c.said("providers").length === 1);
    expect(seen).toEqual([`${entry("kimi").regions!.find((r) => r.id === "cn")!.base}/models`]);
  });
});

describe("a conversation that is open when the provider changes", () => {
  const sse = (): Response => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });

  test("after the key is removed the next message is refused and no request carries the old key; a new key is used from the next message on", async () => {
    const auth: string[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).startsWith(entry("deepseek").base!)) { auth.push(new Headers(init?.headers).get("authorization") ?? ""); return sse(); }
      return real(url, init);
    }) as typeof fetch;
    try {
      const c = computer();
      c.send({ cmd: "provider.save", id: "deepseek", key: "sk-1" });
      await until(() => c.said("providers").length === 1);
      c.send({ cmd: "provider.use", id: "deepseek", model: "m" });
      await until(() => c.said("notice").length === 1);
      const say = async (text: string, errors: number): Promise<void> => { const done = c.said("done").length; c.send({ cmd: "prompt", text, mode: "auto", qid: `q${text}` }); await until(() => c.said("done").length > done || c.said("error").length > errors); };
      await say("one", 0);
      c.send({ cmd: "provider.remove", id: "deepseek" });
      await until(() => c.said("providers").length === 2);
      await say("two", 0);
      expect(c.said("error").map((e) => e.msg)).toEqual([`Add a key for ${entry("deepseek").name} first.`]);
      c.send({ cmd: "provider.save", id: "deepseek", key: "sk-2" });
      await until(() => c.said("providers").length === 3);
      await say("three", 1);
      expect(auth).toEqual(["Bearer sk-1", "Bearer sk-2"]);
    } finally { globalThis.fetch = real; }
  });
});

describe("a model made from a provider holds no key: what is saved is read when the model is used", () => {
  const key = (c: ReturnType<typeof computer>): ReturnType<typeof resolveModel> => {
    const f = loadConfig(c.file);
    if (!f.ok) throw new Error(f.error);
    return resolveModel("deepseek-m", f.value, {}, c.file);
  };

  test("save, use, remove: the key is nowhere in the file and the model refuses in words", async () => {
    const c = computer();
    c.send({ cmd: "provider.save", id: "deepseek", key: "sk-gone-1" });
    await until(() => c.said("providers").length === 1);
    c.send({ cmd: "provider.use", id: "deepseek", model: "m" });
    await until(() => c.said("notice").length === 1);
    expect(key(c)).toMatchObject({ ok: true, value: { provider: { apiKey: "sk-gone-1" } } });
    c.send({ cmd: "provider.remove", id: "deepseek" });
    await until(() => c.said("providers").length === 2);
    expect(readFileSync(c.file, "utf8")).not.toContain("sk-gone-1");
    expect(key(c)).toEqual({ ok: false, error: `Add a key for ${entry("deepseek").name} first.` });
  });

  test("save, use, save a new key: requests carry the new key, and the old one is nowhere", async () => {
    const c = computer();
    c.send({ cmd: "provider.save", id: "deepseek", key: "sk-old" });
    await until(() => c.said("providers").length === 1);
    c.send({ cmd: "provider.use", id: "deepseek", model: "m" });
    await until(() => c.said("notice").length === 1);
    c.send({ cmd: "provider.save", id: "deepseek", key: "sk-new" });
    await until(() => c.said("providers").length === 2);
    expect(key(c)).toMatchObject({ ok: true, value: { provider: { apiKey: "sk-new" } } });
    expect(readFileSync(c.file, "utf8")).not.toContain("sk-old");
  });

  test("a field that changes reaches the model too: the region picks the address when the model is used", async () => {
    const c = computer();
    c.send({ cmd: "provider.save", id: "kimi", key: "k", region: "intl" });
    await until(() => c.said("providers").length === 1);
    c.send({ cmd: "provider.use", id: "kimi", model: "m" });
    await until(() => c.said("notice").length === 1);
    c.send({ cmd: "provider.save", id: "kimi", region: "cn" });
    await until(() => c.said("providers").length === 2);
    const f = loadConfig(c.file);
    if (!f.ok) throw new Error(f.error);
    expect(resolveModel("kimi-m", f.value, {}, c.file)).toMatchObject({ ok: true, value: { provider: { baseUrl: entry("kimi").regions!.find((r) => r.id === "cn")!.base } } });
  });
});

describe("what is hidden in every output", () => {
  const catalogue: ProviderEntry[] = [{ id: "x", name: "X", base: "https://x.test", fields: [{ id: "place", label: "Place" }, { id: "token", label: "Token", secret: true }] }];

  test("the keys and the secret fields, not a region, a project or a place", () => {
    expect(savedSecrets(catalogue, { x: { key: "sk-k", region: "us-east-1", fields: { place: "global", token: "tok-s" } } })).toEqual(["sk-k", "tok-s"]);
  });

  test("the list of the program: a place still shows in what a command prints, a saved key does not", () => {
    const file = { models: { m: { baseUrl: "https://x.test", model: "m", apiKey: "sk-model" } }, providers: { deepseek: { key: "sk-saved" }, vertex: { fields: { project: "my-proj", location: "global" } } } };
    const hidden = secretsOf(file);
    expect(hidden).toEqual(["sk-model", "sk-saved"]);
    expect(redact("echo global my-proj sk-saved sk-model", hidden)).not.toMatch(/sk-saved|sk-model/);
    expect(redact("echo global my-proj", hidden)).toBe("echo global my-proj");
  });
});

describe("what the provider itself never printed is marked", () => {
  test("only these four rest on what widely used open tools ship", () => {
    expect(PROVIDERS.filter((p) => p.evidence).map((p) => p.id)).toEqual(["tokenplan", "minimax-plan", "alibaba-coding", "alibaba-token"]);
  });
});
