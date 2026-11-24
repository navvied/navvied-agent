import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { validateCommand } from "@navvied/protocol";
import { createHub } from "../src/commands/hub.ts";
import { configPath, loadConfig, resolveModel } from "../src/config.ts";
import { secretsOf } from "../src/create.ts";
import type { Machine } from "../src/machine.ts";
import { API_STYLES, authHeaders } from "../src/presets.ts";
import { askModels, detectApi, expandEndpointModel, modelNames, newEndpointId } from "../src/endpoints.ts";
import { fakeIO, remove, tempDir, until } from "./helpers.ts";

const dirs: string[] = [];
const stops: (() => void)[] = [];
/** Every hub made here is stopped before its folders are removed: a hub that is still running holds its engines, their programs and their folders (Windows will not remove a folder that something still has open). */
const hubs: { stop(): Promise<void> }[] = [];
afterAll(async () => { await Promise.all(hubs.map((h) => h.stop())); dirs.forEach(remove); stops.forEach((f) => f()); });

/** A server of the person's own: a list of models, and a chat endpoint that records the key each request carried. */
function server(models: unknown[] = [{ id: "alpha", context_length: 32768 }, { id: "beta", max_model_len: 8192 }, { id: "gamma" }]) {
  const auth: (string | null)[] = [];
  const asked: string[] = [];
  let demand: string | undefined;
  const s = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      asked.push(url.pathname);
      if (demand && req.headers.get("authorization") !== `Bearer ${demand}`) return new Response("no", { status: 401 });
      if (url.pathname === "/v1/models") return Response.json({ data: models });
      if (url.pathname === "/api/tags") return Response.json({ models: [{ name: "llama3:8b" }] });
      if (url.pathname === "/v1/chat/completions") { auth.push(req.headers.get("authorization")); return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } }); }
      return new Response("", { status: 404 });
    },
  });
  stops.push(() => s.stop(true));
  return { url: `http://127.0.0.1:${s.port}/v1`, root: `http://127.0.0.1:${s.port}`, auth, asked, demand: (k: string | undefined) => { demand = k; } };
}

function computer(cloud: false | "config" | "flag" = false) {
  const state = tempDir(), work = tempDir();
  dirs.push(state, work);
  const env = { HOME: state, XDG_STATE_HOME: state, XDG_CONFIG_HOME: state, NAVVIED_GUEST_MODELS: "0" };
  const file = configPath(env);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ models: { own: { baseUrl: "http://127.0.0.1:1/v1", model: "x", apiKey: "sk-own", window: 1000 } }, ...(cloud === "config" ? { webProxy: { url: "http://127.0.0.1:1/v1/web", token: "t" } } : {}) }));
  const hub = createHub({ json: false, yes: false, thinking: false, cwd: work, ...(cloud === "flag" ? { sandboxed: true } : {}) } as never, fakeIO({ env }).io, { watch: false, import: false });
  hubs.push(hub);
  const got: { ev: string; msg?: string; items?: unknown[] }[] = [];
  hub.attach({ send: (line) => { got.push(JSON.parse(String(line))); } }, 0);
  const send = (cmd: object): void => hub.command(JSON.stringify(cmd), () => undefined);
  const said = (ev: string) => got.filter((e) => e.ev === ev);
  const config = (): any => JSON.parse(readFileSync(file, "utf8"));
  return { file, send, said, got, config, env };
}

describe("what a page may send", () => {
  const ok = (c: unknown) => validateCommand(c).ok;
  const form = { cmd: "endpoint.save", name: "My server", baseUrl: "http://127.0.0.1:8080/v1", api: "chat", models: [{ id: "m", window: 4096, vision: true }] };

  test("a form with a name, an address, a way of speaking and models is taken; the key may be absent or empty", () => {
    expect(ok(form)).toBe(true);
    expect(ok({ ...form, key: "" })).toBe(true);
    expect(ok({ ...form, key: "sk-1", id: "custom-a" })).toBe(true);
    expect(validateCommand({ cmd: "endpoints" }).ok).toBe(true);
    expect(validateCommand({ cmd: "endpoint.remove", id: "custom-a" }).ok).toBe(true);
  });

  test("an address that is not a web address, an unknown way of speaking, a model twice, a window that is not a number and a key with spaces are refused", () => {
    expect(ok({ ...form, baseUrl: "file:///etc" })).toBe(false);
    expect(ok({ ...form, api: "grpc" })).toBe(false);
    expect(ok({ ...form, models: [{ id: "m" }, { id: "m" }] })).toBe(false);
    expect(ok({ ...form, models: [{ id: "m", window: "big" }] })).toBe(false);
    expect(ok({ ...form, models: [{ id: "has space" }] })).toBe(false);
    expect(ok({ ...form, key: "has space" })).toBe(false);
    expect(ok({ ...form, name: "  " })).toBe(false);
  });

  test("trying an endpoint takes a saved one by its id, or an address and a way of speaking", () => {
    expect(ok({ cmd: "endpoint.models", id: "custom-a" })).toBe(true);
    expect(ok({ cmd: "endpoint.models", baseUrl: "https://x.test/v1", api: "chat", key: "k" })).toBe(true);
    expect(ok({ cmd: "endpoint.models", baseUrl: "x.test" , api: "chat" })).toBe(false);
  });
});

describe("the pieces", () => {
  test("a new id is made from the name and is never one that is taken; each model gets its own name", () => {
    expect(newEndpointId("My Server!", [])).toBe("custom-my-server");
    expect(newEndpointId("My server", ["custom-my-server"])).toBe("custom-my-server-2");
    const names = modelNames("e", [{ id: "A b" }, { id: "a-b" }, { id: "c" }]);
    expect([...names.values()]).toEqual(["e-a-b", "e-a-b-2", "e-c"]);
  });

  test("what the server says about a model's memory is read from the fields whose names a server's own source or docs show, and from no other", async () => {
    const s = server();
    expect(await askModels(fetch, { baseUrl: s.url, api: "chat", headers: {} })).toEqual({ items: [{ id: "alpha", window: 32768 }, { id: "beta", window: 8192 }, { id: "gamma" }] });
    const mixed = server([{ id: "run", meta: { n_ctx: 4096, n_ctx_train: 131072 } }, { id: "lim", limit: { context: 200000, output: 1000 } }, { id: "trained", meta: { n_ctx_train: 131072 } }, { id: "other", context_window: 9000, n_ctx: 9000, max_context_length: 9000 }]);
    expect(await askModels(fetch, { baseUrl: mixed.url, api: "chat", headers: {} })).toEqual({ items: [{ id: "lim", window: 200000 }, { id: "other" }, { id: "run", window: 4096 }, { id: "trained" }] });
    expect(await askModels(fetch, { baseUrl: s.root, api: "ollama", headers: {} })).toEqual({ items: [{ id: "llama3:8b" }] });
  });

  test("a model that is no longer listed, or an endpoint that is gone, cannot be used and says so", () => {
    expect(expandEndpointModel({}, { endpoint: "e", model: "m" })).toEqual({ error: "That endpoint is not there any more." });
    expect(expandEndpointModel({ e: { name: "E", baseUrl: "http://x", api: "chat", models: [{ id: "n" }] } }, { endpoint: "e", model: "m" })).toEqual({ error: "E no longer lists m." });
  });
});

describe("an endpoint on a computer", () => {
  test("saved: its models become entries that hold no key, the key lives in one place, the file is private, and the page is told everything but the key", async () => {
    const s = server();
    const c = computer();
    c.send({ cmd: "endpoint.save", name: "My server", baseUrl: s.url, api: "chat", key: "sk-endpoint", models: [{ id: "alpha", window: 32768, vision: true }, { id: "beta" }] });
    await until(() => c.said("endpoints").length === 1);
    expect(c.said("endpoints")[0]!.items).toEqual([{ id: "custom-my-server", name: "My server", baseUrl: s.url, api: "chat", key: true, models: [{ id: "alpha", window: 32768, vision: true }, { id: "beta" }] }]);
    expect(JSON.stringify(c.got)).not.toContain("sk-endpoint");
    const config = c.config();
    expect(config.models["custom-my-server-alpha"]).toEqual({ endpoint: "custom-my-server", model: "alpha", display: { name: "alpha", brand: "My server" } });
    expect(config.endpoints["custom-my-server"].key).toBe("sk-endpoint");
    expect(readFileSync(c.file, "utf8").split("sk-endpoint").length - 1).toBe(1);
    if (process.platform !== "win32") expect(statSync(c.file).mode & 0o777).toBe(0o600);
    expect(config.models.own.apiKey).toBe("sk-own");
    const loaded = loadConfig(c.file);
    if (!loaded.ok) throw new Error(loaded.error);
    expect(resolveModel("custom-my-server-alpha", loaded.value, {}, c.file)).toMatchObject({ ok: true, value: { api: "chat", window: 32768, vision: true, provider: { baseUrl: s.url, model: "alpha", apiKey: "sk-endpoint" } } });
    expect(secretsOf(loaded.value)).toContain("sk-endpoint");
  });

  test("saved again: no key keeps the key, an empty key removes it, a new key replaces it, and the choice of the person among its models stays", async () => {
    const s = server();
    const c = computer();
    c.send({ cmd: "endpoint.save", name: "S", baseUrl: s.url, api: "chat", key: "sk-1", models: [{ id: "alpha" }] });
    await until(() => c.said("endpoints").length === 1);
    const raw = c.config();
    raw.default = "custom-s-alpha";
    writeFileSync(c.file, JSON.stringify(raw));
    c.send({ cmd: "endpoint.save", id: "custom-s", name: "S renamed", baseUrl: s.url, api: "chat", models: [{ id: "alpha" }, { id: "beta" }] });
    await until(() => c.said("endpoints").length === 2);
    expect(c.config().endpoints["custom-s"]).toMatchObject({ name: "S renamed", key: "sk-1" });
    expect(c.config().default).toBe("custom-s-alpha");
    expect(Object.keys(c.config().models)).toEqual(["own", "custom-s-alpha", "custom-s-beta"]);
    c.send({ cmd: "endpoint.save", id: "custom-s", name: "S", baseUrl: s.url, api: "chat", key: "sk-2", models: [{ id: "alpha" }] });
    await until(() => c.said("endpoints").length === 3);
    expect(c.config().endpoints["custom-s"].key).toBe("sk-2");
    expect(readFileSync(c.file, "utf8")).not.toContain("sk-1");
    expect(Object.keys(c.config().models)).toEqual(["own", "custom-s-alpha"]);
    c.send({ cmd: "endpoint.save", id: "custom-s", name: "S", baseUrl: s.url, api: "chat", key: "", models: [{ id: "alpha" }] });
    await until(() => c.said("endpoints").length === 4);
    expect(c.config().endpoints["custom-s"].key).toBeUndefined();
    expect(readFileSync(c.file, "utf8")).not.toContain("sk-2");
    expect((c.said("endpoints")[3]!.items as { key: boolean }[])[0]!.key).toBe(false);
  });

  test("removed: the endpoint, its key and its models are gone, and the choice that pointed at one is let go", async () => {
    const s = server();
    const c = computer();
    c.send({ cmd: "endpoint.save", name: "S", baseUrl: s.url, api: "chat", key: "sk-gone", models: [{ id: "alpha" }] });
    await until(() => c.said("endpoints").length === 1);
    const raw = c.config();
    raw.default = "custom-s-alpha"; raw.fallback = ["custom-s-alpha", "own"];
    writeFileSync(c.file, JSON.stringify(raw));
    c.send({ cmd: "endpoint.remove", id: "custom-s" });
    await until(() => c.said("endpoints").length === 2);
    expect(c.said("endpoints")[1]!.items).toEqual([]);
    const text = readFileSync(c.file, "utf8");
    expect(text).not.toContain("sk-gone");
    expect(c.config()).toMatchObject({ models: { own: {} }, fallback: ["own"] });
    expect(c.config().default).toBeUndefined();
    expect(c.config().endpoints).toBeUndefined();
    c.send({ cmd: "endpoint.remove", id: "custom-s" });
    await until(() => c.said("error").length === 1);
  });

  test("tried: a saved endpoint by its id or a form by what it holds; a key the server refuses, a server that is not there and a server with no list each answer one sentence", async () => {
    const s = server();
    const c = computer();
    c.send({ cmd: "endpoint.models", baseUrl: s.url, api: "chat" });
    await until(() => c.said("endpoint.models").length === 1);
    expect(c.said("endpoint.models")[0]!.items).toEqual([{ id: "alpha", window: 32768 }, { id: "beta", window: 8192 }, { id: "gamma" }]);
    s.demand("sk-right");
    c.send({ cmd: "endpoint.models", baseUrl: s.url, api: "chat", key: "sk-wrong" });
    await until(() => c.said("error").length === 1);
    expect(c.said("error")[0]!.msg).toBe("The server did not accept the key.");
    c.send({ cmd: "endpoint.save", name: "S", baseUrl: s.url, api: "chat", key: "sk-right", models: [] });
    await until(() => c.said("endpoints").length === 1);
    c.send({ cmd: "endpoint.models", id: "custom-s" });
    await until(() => c.said("endpoint.models").length === 2);
    expect(c.said("endpoint.models")[1]!.items).toHaveLength(3);
    c.send({ cmd: "endpoint.models", baseUrl: "http://127.0.0.1:1/v1", api: "chat" });
    await until(() => c.said("error").length === 2);
    expect(c.said("error")[1]!.msg).toBe("The server could not be reached.");
    s.demand(undefined);
    c.send({ cmd: "endpoint.models", baseUrl: `${s.root}/nothing`, api: "chat" });
    await until(() => c.said("error").length === 3);
    expect(c.said("error")[2]!.msg).toBe("The server has no list of models: type the name of the model.");
    expect(JSON.stringify(c.got)).not.toContain("sk-right");
  });

  test("in Navvied Cloud every one of these is refused, and nothing is written", async () => {
    for (const how of ["config", "flag"] as const) {
      const c = computer(how);
      const before = readFileSync(c.file, "utf8");
      c.send({ cmd: "endpoint.save", name: "S", baseUrl: "http://127.0.0.1:1/v1", api: "chat", key: "sk-cloud", models: [] });
      c.send({ cmd: "endpoint.models", baseUrl: "http://127.0.0.1:1/v1", api: "chat" });
      c.send({ cmd: "endpoint.remove", id: "custom-s" });
      await until(() => c.said("error").length === 3);
      expect(c.said("error").every((e) => e.msg!.includes("not in Navvied Cloud"))).toBe(true);
      expect(readFileSync(c.file, "utf8")).toBe(before);
    }
  });
});

describe("the way a server is spoken, found by asking it", () => {
  /** A server that answers like one of the styles, and records what it was asked and with which headers. */
  function speaking(style: "chat" | "messages" | "ollama" | "responses" | "silent", opts: { path?: string } = {}) {
    const asked: { path: string; headers: Headers }[] = [];
    const s = Bun.serve({
      port: 0, hostname: "127.0.0.1",
      fetch(req) {
        const url = new URL(req.url);
        asked.push({ path: url.pathname, headers: req.headers });
        if (style === "ollama" && url.pathname === "/api/tags") return Response.json({ models: [{ name: "llama3:8b" }] });
        if (style === "chat" && url.pathname.endsWith("/models")) return Response.json({ object: "list", data: [{ id: "alpha", object: "model", context_length: 65536 }] });
        if (style === "messages" && url.pathname.endsWith("/models")) return Response.json({ data: [{ type: "model", id: "model-x", display_name: "X" }], has_more: false, first_id: "model-x", last_id: "model-x" });
        if (style === "responses" && url.pathname.endsWith("/models")) return Response.json({ object: "list", data: [{ id: "r1", api: { responses: { base_url: "x" } } }, { id: "r2", api: { responses: { base_url: "x" } } }] });
        return new Response("", { status: 404 });
      },
    });
    stops.push(() => s.stop(true));
    return { url: `http://127.0.0.1:${s.port}${opts.path ?? "/v1"}`, root: `http://127.0.0.1:${s.port}`, asked };
  }
  const find = (url: string, key?: string) => detectApi(fetch, url, (api) => authHeaders(api, key), API_STYLES);

  test("each style is found by the list it answers with, and the answer says which", async () => {
    expect(await find(speaking("chat").url)).toEqual({ api: "chat", items: [{ id: "alpha", window: 65536 }] });
    expect(await find(speaking("messages").url, "k")).toEqual({ api: "messages", items: [{ id: "model-x" }] });
    expect(await find(speaking("ollama").root)).toEqual({ api: "ollama", items: [{ id: "llama3:8b" }] });
    expect(await find(speaking("responses").url)).toEqual({ api: "responses", items: [{ id: "r1" }, { id: "r2" }] });
  });

  test("one question to /models carries the key both ways; the third style's own list is asked only when that one has no list", async () => {
    const s = speaking("chat");
    await find(s.url, "sk-k");
    expect(s.asked.map((a) => a.path)).toEqual(["/v1/models"]);
    expect(s.asked[0]!.headers.get("authorization")).toBe("Bearer sk-k");
    expect(s.asked[0]!.headers.get("x-api-key")).toBe("sk-k");
    const o = speaking("ollama");
    await find(o.root);
    expect(o.asked.map((a) => a.path)).toEqual(["/models", "/api/tags"]);
  });

  test("a path that names the messages style settles a list that could be either", async () => {
    expect(await find(speaking("chat", { path: `/${API_STYLES.messages.label.toLowerCase()}/v1` }).url)).toMatchObject({ api: "messages" });
    expect(await find(speaking("chat", { path: "/other/v1" }).url)).toMatchObject({ api: "chat" });
  });

  test("nothing that answers: the sentence says what was tried; a refused key and a server that is not there say that instead", async () => {
    expect(await find(speaking("silent").url)).toEqual({ error: `The server did not answer with a list of models in the ${API_STYLES.chat.label}, ${API_STYLES.messages.label} or ${API_STYLES.ollama.label} style (tried /models and /api/tags): choose how it is spoken, and type the name of the model.` });
    const guarded = server();
    guarded.demand("sk-right");
    expect(await find(guarded.url, "sk-wrong")).toEqual({ error: "The server did not accept the key." });
    expect(await find("http://127.0.0.1:1/v1")).toEqual({ error: "The server could not be reached." });
  });

  test("through the hub: auto is the default, the style found is what is saved and what the answer names, and a form that names one is not asked about the others", async () => {
    const s = speaking("messages");
    const c = computer();
    c.send({ cmd: "endpoint.models", baseUrl: s.url, key: "k" });
    await until(() => c.said("endpoint.models").length === 1);
    expect(c.said("endpoint.models")[0]).toMatchObject({ api: "messages", items: [{ id: "model-x" }] });
    c.send({ cmd: "endpoint.save", name: "A", baseUrl: s.url, api: "auto", key: "k", models: [{ id: "model-x" }] });
    await until(() => c.said("endpoints").length === 1);
    expect(c.config().endpoints["custom-a"].api).toBe("messages");
    expect(JSON.stringify(c.config())).not.toContain('"auto"');
    const before = s.asked.length;
    c.send({ cmd: "endpoint.save", id: "custom-a", name: "A", baseUrl: s.url, api: "chat", models: [{ id: "model-x" }] });
    await until(() => c.said("endpoints").length === 2);
    expect(c.config().endpoints["custom-a"].api).toBe("chat");
    expect(s.asked.length).toBe(before);
    c.send({ cmd: "endpoint.save", name: "Dead", baseUrl: "http://127.0.0.1:1/v1", api: "auto", models: [] });
    await until(() => c.said("error").length === 1);
    expect(c.config().endpoints["custom-dead"]).toBeUndefined();
  });
});

describe("the memory size the two local servers say elsewhere", () => {
  function local(kind: "lmstudio" | "ollama" | "plain") {
    const asked: string[] = [];
    const s = Bun.serve({
      port: 0, hostname: "127.0.0.1",
      async fetch(req) {
        const url = new URL(req.url);
        asked.push(`${req.method} ${url.pathname}`);
        if (url.pathname === "/v1/models") return Response.json({ data: [{ id: "a" }, { id: "b" }] });
        if (url.pathname === "/api/tags") return Response.json({ models: [{ name: "a", size: 4_700_000_000 }, { name: "b", size: 20_000_000_000 }] });
        if (kind === "lmstudio" && url.pathname === "/api/v1/models") return Response.json({ models: [{ key: "a", max_context_length: 131072, loaded_instances: [{ id: "a", config: { context_length: 4096 } }] }, { key: "b", max_context_length: 32768, loaded_instances: [] }] });
        if (kind === "ollama" && url.pathname === "/api/show" && req.method === "POST") {
          const { model } = (await req.json()) as { model: string };
          return Response.json({ model_info: { "general.architecture": "llama", "llama.block_count": 32, "llama.attention.head_count": 32, "llama.attention.head_count_kv": 8, "llama.embedding_length": 4096, "llama.context_length": model === "a" ? 131072 : 8192 } });
        }
        return new Response("", { status: 404 });
      },
    });
    stops.push(() => s.stop(true));
    return { url: `http://127.0.0.1:${s.port}/v1`, root: `http://127.0.0.1:${s.port}`, asked };
  }
  const laptop = async (): Promise<Machine> => ({ os: "linux", arch: "x64", gpus: [], ramMb: 16384, freeRamMb: 12000 });

  test("LM Studio: the size the model was loaded with, and none for a model that is not loaded (the supported size is not what the server uses)", async () => {
    const l = local("lmstudio");
    expect(await askModels(fetch, { baseUrl: l.url, api: "chat", headers: {} })).toEqual({ items: [{ id: "a", window: 4096 }, { id: "b" }] });
    expect(l.asked).toEqual(["GET /v1/models", "GET /api/v1/models"]);
  });

  test("Ollama: the largest size that fits in the free memory, never more than the model supports; none when not even the smallest fits", async () => {
    const o = local("ollama");
    expect(await askModels(fetch, { baseUrl: o.url, api: "chat", headers: {}, machine: laptop })).toEqual({ items: [{ id: "a", window: 32768 }, { id: "b" }] });
    const o2 = local("ollama");
    expect(await askModels(fetch, { baseUrl: o2.root, api: "ollama", headers: {}, machine: laptop })).toEqual({ items: [{ id: "a", window: 32768 }, { id: "b" }] });
  });

  test("Ollama on a computer with more memory gets what the model supports; without the machine nothing is claimed", async () => {
    const big = async (): Promise<Machine> => ({ os: "linux", arch: "x64", gpus: [{ name: "x", vendor: "nvidia", kind: "discrete", memoryMb: 49152, freeMb: 49000 }], ramMb: 65536, freeRamMb: 60000 });
    expect((await askModels(fetch, { baseUrl: local("ollama").url, api: "chat", headers: {}, machine: big }) as { items: { id: string; window?: number }[] }).items[0]).toEqual({ id: "a", window: 131072 });
    expect(await askModels(fetch, { baseUrl: local("ollama").url, api: "chat", headers: {} })).toEqual({ items: [{ id: "a" }, { id: "b" }] });
  });

  test("a server that is neither gets two more questions at most, and no window", async () => {
    const p = local("plain");
    expect(await askModels(fetch, { baseUrl: p.url, api: "chat", headers: {}, machine: laptop })).toEqual({ items: [{ id: "a" }, { id: "b" }] });
    expect(p.asked).toEqual(["GET /v1/models", "GET /api/v1/models", "GET /api/tags", "POST /api/show", "POST /api/show"]);
  });
});

describe("every window is told the models at once", () => {
  const names = (c: ReturnType<typeof computer>): string[] => ((c.said("caps").at(-1) as unknown as { models: { id: string }[] }).models).map((m) => m.id);

  test("a saved endpoint's models are in the list without a restart, flagged as reached by a hand-over, and a removed one's are gone; the engine's own stay", async () => {
    const s = server();
    const c = computer();
    await until(() => c.said("caps").length > 0);
    expect(names(c)).toEqual(["own"]);
    c.send({ cmd: "endpoint.save", name: "S", baseUrl: s.url, api: "chat", models: [{ id: "alpha" }, { id: "beta" }] });
    await until(() => names(c).includes("custom-s-alpha"));
    expect(names(c)).toEqual(["own", "custom-s-alpha", "custom-s-beta"]);
    const caps = c.said("caps").at(-1) as unknown as { models: { id: string; handover?: boolean; current?: boolean }[] };
    expect(caps.models.find((m) => m.id === "custom-s-alpha")).toMatchObject({ handover: true });
    expect(caps.models.find((m) => m.id === "own")!.handover).toBeUndefined();
    c.send({ cmd: "endpoint.save", id: "custom-s", name: "S", baseUrl: s.url, api: "chat", models: [{ id: "alpha" }] });
    await until(() => !names(c).includes("custom-s-beta"));
    expect(names(c)).toEqual(["own", "custom-s-alpha"]);
    c.send({ cmd: "endpoint.remove", id: "custom-s" });
    await until(() => names(c).length === 1);
    expect(names(c)).toEqual(["own"]);
  });

  test("choosing a model that was added after the engine started hands the conversation over to it", async () => {
    const s = server();
    const c = computer();
    await until(() => c.said("caps").length > 0);
    c.send({ cmd: "endpoint.save", name: "S", baseUrl: s.url, api: "chat", models: [{ id: "alpha" }] });
    await until(() => names(c).includes("custom-s-alpha"));
    c.send({ cmd: "model", id: "custom-s-alpha" });
    await until(() => c.said("notice").length === 1);
    expect(c.said("error")).toEqual([]);
    const now = (c.said("caps").at(-1) as unknown as { models: { id: string; current?: boolean }[] }).models;
    await until(() => ((c.said("caps").at(-1) as unknown as { models: { id: string; current?: boolean }[] }).models.find((m) => m.current)?.id) === "custom-s-alpha");
    expect(now.length).toBeGreaterThan(0);
  });
});

describe("a conversation that is open when its endpoint changes", () => {
  test("a new key is used from the next message, an empty key sends none, and a removed endpoint refuses the next message", async () => {
    const s = server();
    const c = computer();
    c.send({ cmd: "endpoint.save", name: "S", baseUrl: s.url, api: "chat", key: "sk-1", models: [{ id: "alpha" }] });
    await until(() => c.said("endpoints").length === 1);
    c.send({ cmd: "model", id: "custom-s-alpha" });
    await until(() => c.said("notice").length === 1);
    const say = async (text: string): Promise<void> => { const before = c.said("done").length + c.said("error").length; c.send({ cmd: "prompt", text, mode: "auto", qid: `q-${text}` }); await until(() => c.said("done").length + c.said("error").length > before); };
    await say("one");
    c.send({ cmd: "endpoint.save", id: "custom-s", name: "S", baseUrl: s.url, api: "chat", key: "sk-2", models: [{ id: "alpha" }] });
    await until(() => c.said("endpoints").length === 2);
    await say("two");
    c.send({ cmd: "endpoint.save", id: "custom-s", name: "S", baseUrl: s.url, api: "chat", key: "", models: [{ id: "alpha" }] });
    await until(() => c.said("endpoints").length === 3);
    await say("three");
    expect(s.auth).toEqual(["Bearer sk-1", "Bearer sk-2", null]);
    c.send({ cmd: "endpoint.remove", id: "custom-s" });
    await until(() => c.said("endpoints").length === 4);
    await say("four");
    expect(c.said("error")).toHaveLength(1);
    expect(s.auth).toHaveLength(3);
  });
});
