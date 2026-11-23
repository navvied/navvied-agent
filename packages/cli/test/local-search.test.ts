import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { validateCommand } from "@navvied/protocol";
import { createHub } from "../src/commands/hub.ts";
import { configPath } from "../src/config.ts";
import { MODEL_HUB, RECOMMENDED_MODELS } from "../src/presets.ts";
import { fakeIO, remove, tempDir, until } from "./helpers.ts";
import { llama } from "./gguf-builder.ts";

const dirs: string[] = [];
afterAll(() => { dirs.forEach(remove); });
const MB = 1024 * 1024;

/** A computer whose model hub is a few canned answers: what the hub is asked is kept, with the token. */
function computer(o: { cloud?: false | "flag" | "config"; token?: string } = {}) {
  const asked: { url: string; auth: string | null }[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const auth = new Headers(init?.headers).get("authorization");
    asked.push({ url: u, auth });
    if (!u.startsWith(MODEL_HUB.base)) return new Response("", { status: 404 });
    const path = u.slice(MODEL_HUB.base.length);
    if (path.startsWith("/api/models?")) return Response.json([{ id: "org/tiny", gated: false, downloads: 9, gguf: { chat_template: "{% if tools %}x{% endif %}" } }, { id: "org/locked", gated: "manual", downloads: 3, gguf: { chat_template: "{{ messages }}" } }]);
    if (path === "/api/models/org/tiny/tree/main") return Response.json([{ type: "file", path: "tiny-Q4_K_M.gguf", size: 134, lfs: { oid: "abc", size: 300 * MB } }]);
    if (path === "/api/models/org/locked/tree/main") return auth ? Response.json([{ type: "file", path: "locked-Q4_K_M.gguf", size: 134, lfs: { oid: "def", size: 400 * MB } }]) : new Response("", { status: 401 });
    if (path.includes("/resolve/main/")) return new Response(llama({ layers: 4, embed: 512, heads: 8, kvHeads: 2 }).slice(0, 4096), { status: 206 });
    return new Response("", { status: 404 });
  }) as unknown as typeof fetch;
  const state = tempDir(), work = tempDir();
  dirs.push(state, work);
  const env = { HOME: state, XDG_STATE_HOME: state, XDG_CONFIG_HOME: state, NAVVIED_GUEST_MODELS: "0" };
  const file = configPath(env);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ models: { m: { baseUrl: "http://127.0.0.1:1/v1", model: "x", window: 1000 } }, ...(o.token ? { providers: { [MODEL_HUB.tokenProvider]: { key: o.token } } } : {}), ...(o.cloud === "config" ? { webProxy: { url: "http://127.0.0.1:1/v1/web", token: "t" } } : {}) }));
  const hub = createHub({ json: false, yes: false, thinking: false, cwd: work, ...(o.cloud === "flag" ? { sandboxed: true } : {}) } as never, fakeIO({ env, fetch: fetchFn }).io, { watch: false, import: false });
  const got: { ev: string; msg?: string; items?: Record<string, unknown>[]; notes?: string[] }[] = [];
  hub.attach({ send: (line) => { got.push(JSON.parse(String(line))); } }, 0);
  return { asked, got, send: (cmd: object) => hub.command(JSON.stringify(cmd), () => undefined) };
}

describe("what a page may send", () => {
  test("words, and a window of a usual size or none", () => {
    expect(validateCommand({ cmd: "local.search", query: "  qwen coder " })).toEqual({ ok: true, value: { cmd: "local.search", query: "qwen coder" } });
    expect(validateCommand({ cmd: "local.search", query: "q", window: 16384 }).ok).toBe(true);
    expect(validateCommand({ cmd: "local.search", query: " " }).ok).toBe(false);
    expect(validateCommand({ cmd: "local.search", query: "q", window: 12 }).ok).toBe(false);
    expect(validateCommand({ cmd: "local.search", query: "x".repeat(201) }).ok).toBe(false);
  });
});

describe("a search through the hub", () => {
  test("files with their quant, size and where they run here, the page of the model for its licence, and the licence-gated one left out without a token", async () => {
    const c = computer();
    c.send({ cmd: "local.search", query: "tiny" });
    await until(() => c.got.some((e) => e.ev === "local.found"));
    const found = c.got.find((e) => e.ev === "local.found")!;
    expect(found.items).toHaveLength(1);
    expect(found.items![0]).toMatchObject({ repo: "org/tiny", page: `${MODEL_HUB.base}/org/tiny`, file: "tiny-Q4_K_M.gguf", quant: "Q4_K_M", sizeMb: 300, parts: 1, gated: false, window: 32768, tools: true });
    expect(["gpu", "ram", "none"]).toContain(found.items![0]!.fit as string);
    expect(found.notes).toEqual(["org/locked: This model needs the licence accepted on its page, and a token."]);
    expect(c.asked[0]!.url).toContain("search=tiny");
    expect(c.asked[0]!.url).toContain("expand[]=gguf");
    expect(c.asked.every((a) => a.auth === null)).toBe(true);
  });

  test("with the token saved for the hub's provider the licence-gated file is there too, and the token goes only to the hub", async () => {
    const c = computer({ token: "hf-token-1" });
    c.send({ cmd: "local.search", query: "tiny", window: 8192 });
    await until(() => c.got.some((e) => e.ev === "local.found"));
    const found = c.got.find((e) => e.ev === "local.found")!;
    expect(found.items!.map((i) => i.repo)).toContain("org/locked");
    expect(found.items!.find((i) => i.repo === "org/locked")).toMatchObject({ gated: true, window: 8192, tools: false });
    expect(found.items!.find((i) => i.repo === "org/tiny")).toMatchObject({ tools: true });
    expect(c.asked.every((a) => a.url.startsWith(MODEL_HUB.base) && a.auth === "Bearer hf-token-1")).toBe(true);
    expect(JSON.stringify(c.got)).not.toContain("hf-token-1");
  });

  test("the models to start with are asked from the repositories of the program's own list, and the answer says it is that", async () => {
    const c = computer();
    c.send({ cmd: "local.recommended", window: 8192 });
    await until(() => c.got.some((e) => e.ev === "local.found"));
    const found = c.got.find((e) => e.ev === "local.found") as { items: unknown[]; notes: string[]; recommended?: boolean };
    expect(found.recommended).toBe(true);
    expect(found.items).toEqual([]);
    expect(found.notes).toHaveLength(RECOMMENDED_MODELS.length);
    expect(c.asked.map((a) => a.url).sort()).toEqual(RECOMMENDED_MODELS.map((m) => `${MODEL_HUB.base}/api/models/${m.repo}`).sort());
  });

  test("in Navvied Cloud it is refused and the hub is not asked", async () => {
    for (const how of ["flag", "config"] as const) {
      const c = computer({ cloud: how });
      c.send({ cmd: "local.search", query: "tiny" });
      await until(() => c.got.some((e) => e.ev === "error"));
      expect(c.got.find((e) => e.ev === "error")!.msg).toContain("never in Navvied Cloud");
      expect(c.asked).toEqual([]);
    }
  });
});
