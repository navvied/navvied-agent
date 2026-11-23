import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { validateCommand } from "@navvied/protocol";
import { createHub } from "../src/commands/hub.ts";
import { configPath, localDir } from "../src/config.ts";
import { MODEL_HUB } from "../src/presets.ts";
import { fakeIO, remove, tempDir, until } from "./helpers.ts";

const dirs: string[] = [];
afterAll(() => { dirs.forEach(remove); });

const noise = (n: number, seed: number): Uint8Array => new Uint8Array(n).map((_, i) => (i * 131 + seed * 17 + (i >> 8)) % 251);
const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

interface FileSpec { path: string; bytes: Uint8Array; claimedSize?: number; oid?: string }

/** A model hub in a function: the files of one repository, a Range that is honoured, a stall that can be let go, and what it was asked with. */
function hub(repo: string, files: FileSpec[], o: { gated?: boolean; stallAfter?: number } = {}) {
  const asked: { url: string; auth: string | null; range: string | null }[] = [];
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => { release = r; });
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const h = new Headers(init?.headers);
    asked.push({ url: u, auth: h.get("authorization"), range: h.get("range") });
    const path = u.startsWith(MODEL_HUB.base) ? u.slice(MODEL_HUB.base.length) : "";
    if (path === `/api/models/${repo}/tree/main`) {
      if (o.gated && !h.get("authorization")) return new Response("", { status: 401 });
      return Response.json(files.map((f) => ({ type: "file", path: f.path, size: 134, lfs: { oid: f.oid ?? sha(f.bytes), size: f.claimedSize ?? f.bytes.length, pointerSize: 134 } })));
    }
    const m = new RegExp(`^/${repo}/resolve/main/(.+)$`).exec(path);
    if (m) {
      if (o.gated && !h.get("authorization")) return new Response("", { status: 401 });
      const f = files.find((x) => x.path === m[1]);
      if (!f) return new Response("", { status: 404 });
      const r = /bytes=(\d+)-/.exec(h.get("range") ?? "");
      const from = r ? Number(r[1]) : 0;
      const rest = f.bytes.slice(from);
      const cut = o.stallAfter !== undefined && from === 0 ? o.stallAfter : rest.length;
      const body = new ReadableStream({ async start(c) { init?.signal?.addEventListener("abort", () => { try { c.error(new DOMException("aborted", "AbortError")); } catch { /* ended */ } }); c.enqueue(rest.slice(0, cut)); if (cut < rest.length) await gate; try { c.enqueue(rest.slice(cut)); c.close(); } catch { /* aborted */ } } });
      return new Response(body, { status: r ? 206 : 200, headers: { "content-length": String(rest.length), ...(r ? { "content-range": `bytes ${from}-${f.bytes.length - 1}/${f.bytes.length}` } : {}) } });
    }
    return new Response("", { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchFn, asked, release: () => release() };
}

type Ev = { ev: string; state?: string; repo?: string; file?: string; bytes?: number; total?: number; error?: string; msg?: string; items?: { repo: string; file: string; quant: string; sizeMb: number; state: string }[] };

function computer(fetchFn: typeof fetch, o: { cloud?: false | "flag" | "config"; token?: string } = {}) {
  const state = tempDir(), work = tempDir();
  dirs.push(state, work);
  const env = { HOME: state, XDG_STATE_HOME: state, XDG_CONFIG_HOME: state, NAVVIED_GUEST_MODELS: "0" };
  const file = configPath(env);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ models: { m: { baseUrl: "http://127.0.0.1:1/v1", model: "x", window: 1000 } }, ...(o.token ? { providers: { [MODEL_HUB.tokenProvider]: { key: o.token } } } : {}), ...(o.cloud === "config" ? { webProxy: { url: "http://127.0.0.1:1/v1/web", token: "t" } } : {}) }));
  const hubInstance = createHub({ json: false, yes: false, thinking: false, cwd: work, ...(o.cloud === "flag" ? { sandboxed: true } : {}) } as never, fakeIO({ env, fetch: fetchFn }).io, { watch: false, import: false });
  const got: Ev[] = [];
  hubInstance.attach({ send: (line) => { got.push(JSON.parse(String(line))); } }, 0);
  const local = localDir(env);
  return { got, local, send: (cmd: object) => hubInstance.command(JSON.stringify(cmd), () => undefined), files: (e: string) => got.filter((x) => x.ev === "local.file" && x.state === e), last: (ev: string) => got.filter((x) => x.ev === ev).at(-1) };
}

const REPO = "org/tiny";
const MODEL = "tiny-Q4_K_M.gguf";
const where = (c: { local: string }, p = MODEL): string => join(c.local, "models", "org--tiny", p);

describe("what a page may send", () => {
  test("a repository and a .gguf file of it, and nothing that reaches outside", () => {
    expect(validateCommand({ cmd: "local.pull", repo: REPO, file: MODEL }).ok).toBe(true);
    expect(validateCommand({ cmd: "local.remove", repo: REPO, file: "dir/x-00001-of-00002.gguf" }).ok).toBe(true);
    for (const bad of [{ repo: "nope", file: MODEL }, { repo: REPO, file: "../x.gguf" }, { repo: REPO, file: "a/../x.gguf" }, { repo: REPO, file: "x.bin" }, { repo: REPO, file: "a\\x.gguf" }, { repo: "a/b/c", file: MODEL }]) expect(validateCommand({ cmd: "local.pull", ...bad }).ok).toBe(false);
    expect(validateCommand({ cmd: "local.models" }).ok).toBe(true);
  });
});

describe("fetching a model", () => {
  test("every byte comes, the hash is the published one, the file is in its place, the part is gone, the progress is told, and the model is written down", async () => {
    const bytes = noise(600_000, 1);
    const h = hub(REPO, [{ path: MODEL, bytes }]);
    const c = computer(h.fetchFn);
    c.send({ cmd: "local.pull", repo: REPO, file: MODEL });
    await until(() => c.files("done").length === 1);
    expect(sha(new Uint8Array(readFileSync(where(c))))).toBe(sha(bytes));
    expect(existsSync(`${where(c)}.part`)).toBe(false);
    expect(c.files("downloading").length).toBeGreaterThan(0);
    expect(c.files("downloading").at(-1)).toMatchObject({ repo: REPO, file: MODEL, total: 600_000 });
    expect(c.files("done")[0]).toMatchObject({ bytes: 600_000, total: 600_000 });
    c.send({ cmd: "local.models" });
    await until(() => c.got.filter((e) => e.ev === "local.installed").length >= 2);
    expect(c.last("local.installed")!.items).toEqual([{ repo: REPO, file: MODEL, quant: "Q4_K_M", sizeMb: 1, state: "done" }]);
  });

  test("paused it leaves the part and says how far; fetched again it goes on from there, and only the rest is asked for", async () => {
    const bytes = noise(900_000, 2);
    const h = hub(REPO, [{ path: MODEL, bytes }], { stallAfter: 300_000 });
    const c = computer(h.fetchFn);
    c.send({ cmd: "local.pull", repo: REPO, file: MODEL });
    await until(() => existsSync(`${where(c)}.part`) && readFileSync(`${where(c)}.part`).length >= 300_000);
    c.send({ cmd: "local.pause", repo: REPO, file: MODEL });
    await until(() => c.files("paused").length === 1);
    expect(c.files("paused")[0]!.bytes).toBeGreaterThanOrEqual(300_000);
    expect(existsSync(where(c))).toBe(false);
    h.release();
    c.send({ cmd: "local.pull", repo: REPO, file: MODEL });
    await until(() => c.files("done").length === 1);
    expect(sha(new Uint8Array(readFileSync(where(c))))).toBe(sha(bytes));
    const resolves = h.asked.filter((a) => a.url.includes("/resolve/"));
    expect(resolves[0]!.range).toBeNull();
    expect(resolves[1]!.range).toMatch(/^bytes=\d+-$/);
  });

  test("cancelled it takes what was fetched away and nothing is kept", async () => {
    const h = hub(REPO, [{ path: MODEL, bytes: noise(900_000, 3) }], { stallAfter: 200_000 });
    const c = computer(h.fetchFn);
    c.send({ cmd: "local.pull", repo: REPO, file: MODEL });
    await until(() => existsSync(`${where(c)}.part`) && readFileSync(`${where(c)}.part`).length >= 200_000);
    c.send({ cmd: "local.cancel", repo: REPO, file: MODEL });
    await until(() => c.files("idle").length >= 1);
    expect(existsSync(`${where(c)}.part`)).toBe(false);
    expect(existsSync(where(c))).toBe(false);
    h.release();
    c.send({ cmd: "local.models" });
    await until(() => c.got.some((e) => e.ev === "local.installed"));
    expect(c.last("local.installed")!.items).toEqual([]);
  });

  test("a file that is not the one the hub published is deleted, not kept, and said so", async () => {
    const h = hub(REPO, [{ path: MODEL, bytes: noise(300_000, 4), oid: "0".repeat(64) }]);
    const c = computer(h.fetchFn);
    c.send({ cmd: "local.pull", repo: REPO, file: MODEL });
    await until(() => c.files("failed").length === 1);
    expect(c.files("failed")[0]!.error).toBe(`${MODEL} is not the file the model hub published (its hash is different): it was deleted.`);
    expect(existsSync(where(c))).toBe(false);
    expect(existsSync(`${where(c)}.part`)).toBe(false);
    c.send({ cmd: "local.models" });
    await until(() => c.got.some((e) => e.ev === "local.installed"));
    expect(c.last("local.installed")!.items!.filter((i) => i.state === "done")).toEqual([]);
  });

  test("no room on the disk is said before a byte is fetched: how much is needed and how much is free", async () => {
    const h = hub(REPO, [{ path: MODEL, bytes: noise(300_000, 5), claimedSize: 10 ** 15 }]);
    const c = computer(h.fetchFn);
    c.send({ cmd: "local.pull", repo: REPO, file: MODEL });
    await until(() => c.files("nodisk").length === 1);
    expect(c.files("nodisk")[0]!.error).toMatch(/^There is not enough room on the disk: \d+ MB are needed and \d+ MB are free\.$/);
    expect(h.asked.some((a) => a.url.includes("/resolve/"))).toBe(false);
  });

  test("a model in parts is fetched part by part, each proven, kept as one, and taken away as one with its empty folders", async () => {
    const a = noise(200_000, 6), b = noise(150_000, 7);
    const h = hub(REPO, [{ path: "big/m-Q8_0-00001-of-00002.gguf", bytes: a }, { path: "big/m-Q8_0-00002-of-00002.gguf", bytes: b }]);
    const c = computer(h.fetchFn);
    c.send({ cmd: "local.pull", repo: REPO, file: "big/m-Q8_0-00001-of-00002.gguf" });
    await until(() => c.files("done").length === 1);
    expect(existsSync(where(c, "big/m-Q8_0-00001-of-00002.gguf"))).toBe(true);
    expect(existsSync(where(c, "big/m-Q8_0-00002-of-00002.gguf"))).toBe(true);
    expect(c.files("done")[0]).toMatchObject({ bytes: 350_000, total: 350_000 });
    c.send({ cmd: "local.remove", repo: REPO, file: "big/m-Q8_0-00001-of-00002.gguf" });
    await until(() => c.files("idle").length >= 1);
    expect(existsSync(join(c.local, "models", "org--tiny"))).toBe(false);
    expect(JSON.parse(readFileSync(join(c.local, "models", "installed.json"), "utf8"))).toEqual([]);
  });

  test("a licence not accepted is said; with the token it goes to the hub, which is the only one that gets it", async () => {
    const bytes = noise(100_000, 8);
    const h = hub(REPO, [{ path: MODEL, bytes }], { gated: true });
    const without = computer(h.fetchFn);
    without.send({ cmd: "local.pull", repo: REPO, file: MODEL });
    await until(() => without.files("failed").length === 1);
    expect(without.files("failed")[0]!.error).toBe("This model needs the licence accepted on its page, and a token.");
    const h2 = hub(REPO, [{ path: MODEL, bytes }], { gated: true });
    const withToken = computer(h2.fetchFn, { token: "hf-secret" });
    withToken.send({ cmd: "local.pull", repo: REPO, file: MODEL });
    await until(() => withToken.files("done").length === 1);
    expect(h2.asked.every((a) => a.url.startsWith(MODEL_HUB.base) && a.auth === "Bearer hf-secret")).toBe(true);
    expect(JSON.stringify(withToken.got)).not.toContain("hf-secret");
  });

  test("a second request for a file that is being fetched changes nothing", async () => {
    const h = hub(REPO, [{ path: MODEL, bytes: noise(500_000, 9) }], { stallAfter: 100_000 });
    const c = computer(h.fetchFn);
    c.send({ cmd: "local.pull", repo: REPO, file: MODEL });
    await until(() => existsSync(`${where(c)}.part`) && readFileSync(`${where(c)}.part`).length >= 100_000);
    c.send({ cmd: "local.pull", repo: REPO, file: MODEL });
    h.release();
    await until(() => c.files("done").length === 1);
    expect(h.asked.filter((a) => a.url.includes("/resolve/"))).toHaveLength(1);
  });

  test("in Navvied Cloud every one is refused and the hub is not asked", async () => {
    for (const how of ["flag", "config"] as const) {
      const h = hub(REPO, [{ path: MODEL, bytes: noise(1000, 1) }]);
      const c = computer(h.fetchFn, { cloud: how });
      for (const cmd of ["local.pull", "local.pause", "local.cancel", "local.remove"]) c.send({ cmd, repo: REPO, file: MODEL });
      c.send({ cmd: "local.models" });
      await until(() => c.got.filter((e) => e.ev === "error").length === 5);
      expect(c.got.filter((e) => e.ev === "error").every((e) => e.msg?.includes("never in Navvied Cloud"))).toBe(true);
      expect(h.asked).toEqual([]);
    }
  });
});
