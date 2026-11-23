import { afterAll, describe, expect, test } from "bun:test";
import type { Machine } from "../src/machine.ts";
import { listFiles, rateOf, readRemoteShape, recommendedModels, searchModels } from "../src/model-hub.ts";
import { gguf, llama } from "./gguf-builder.ts";

const stops: (() => void)[] = [];
afterAll(() => { stops.forEach((f) => f()); });

interface Repo { id: string; gated?: boolean | string; downloads?: number; files: { path: string; size: number; lfs?: boolean }[]; header?: Uint8Array; template?: string }

/** A hub of a few repositories: a search, the files of each, and the start of a file by Range; it records what it was asked, with which token. */
function hub(repos: Repo[], o: { remaining?: () => number; status429?: boolean } = {}) {
  const log: { path: string; auth: string | null; range: string | null }[] = [];
  const s = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      log.push({ path: url.pathname + url.search, auth: req.headers.get("authorization"), range: req.headers.get("range") });
      const kind = url.pathname.includes("/resolve/") ? "resolvers" : "api";
      const rate = { "ratelimit": `"${kind}";r=${o.remaining?.() ?? 400};t=200` };
      if (o.status429) return new Response("", { status: 429, headers: { "retry-after": "42" } });
      if (url.pathname === "/api/models") return Response.json(repos.map((r) => ({ id: r.id, gated: r.gated ?? false, downloads: r.downloads ?? 1 })), { headers: rate });
      const one = /^\/api\/models\/(.+)$/.exec(url.pathname);
      if (one && !one[1]!.endsWith("/tree/main")) {
        const r = repos.find((x) => x.id === one[1]);
        return r ? Response.json({ id: r.id, gated: r.gated ?? false, ...(r.template !== undefined ? { gguf: { chat_template: r.template } } : {}) }, { headers: rate }) : new Response("", { status: 404 });
      }
      const tree = /^\/api\/models\/(.+)\/tree\/main$/.exec(url.pathname);
      if (tree) {
        const r = repos.find((x) => x.id === tree[1]);
        if (!r) return new Response("", { status: 404 });
        if (r.gated && !req.headers.get("authorization")) return new Response("", { status: 401 });
        return Response.json([{ type: "file", path: "README.md", size: 10 }, ...r.files.map((f) => ({ type: "file", path: f.path, size: f.lfs === false ? f.size : 134, ...(f.lfs === false ? {} : { lfs: { oid: `sha-${f.path}`, size: f.size, pointerSize: 134 } }) }))], { headers: rate });
      }
      const file = /^\/(.+?)\/resolve\/main\/(.+)$/.exec(url.pathname);
      if (file) {
        const r = repos.find((x) => x.id === file[1]);
        if (!r) return new Response("", { status: 404 });
        if (r.gated && !req.headers.get("authorization")) return new Response("", { status: 401 });
        const bytes = r.header ?? llama();
        const m = /bytes=(\d+)-(\d+)/.exec(req.headers.get("range") ?? "");
        return new Response(m ? bytes.slice(Number(m[1]), Number(m[2]) + 1) : bytes, { status: m ? 206 : 200, headers: rate });
      }
      return new Response("", { status: 404 });
    },
  });
  stops.push(() => s.stop(true));
  return { base: `http://127.0.0.1:${s.port}`, log };
}

const MB = 1024 * 1024;
const laptop: Machine = { os: "linux", arch: "x64", gpus: [], ramMb: 16384, freeRamMb: 12000 };
const withCard: Machine = { ...laptop, gpus: [{ name: "card", vendor: "nvidia", kind: "discrete", memoryMb: 24564, freeMb: 23000 }] };
const small = (id: string, extra: Partial<Repo> = {}): Repo => ({ id, files: [{ path: "m-Q4_K_M.gguf", size: 4700 * MB }, { path: "m-Q8_0.gguf", size: 8500 * MB }, { path: "m-IQ2_XS.gguf", size: 2400 * MB }, { path: "m-BF16.gguf", size: 16000 * MB }, { path: "mmproj-F16.gguf", size: 600 * MB }], ...extra });

describe("the files of a repository", () => {
  test("only the GGUF models, each with its quant and its size, a model in parts as one, a vision projector left out", async () => {
    const h = hub([{ id: "a/b", files: [{ path: "m-Q4_K_M.gguf", size: 100 }, { path: "big-Q8_0-00001-of-00002.gguf", size: 700 }, { path: "big-Q8_0-00002-of-00002.gguf", size: 300 }, { path: "mmproj-f16.gguf", size: 50 }, { path: "weights.safetensors", size: 9 }, { path: "m.FP16.gguf", size: 400 }] }]);
    const files = await listFiles(fetch, h, "a/b", false, undefined);
    if ("error" in files) throw new Error(files.error);
    expect(files.map((f) => ({ file: f.file, quant: f.quant, sizeBytes: f.sizeBytes, parts: f.parts.map((p) => p.path), sha256: f.parts.map((p) => p.sha256) }))).toEqual([
      { file: "m-Q4_K_M.gguf", quant: "Q4_K_M", sizeBytes: 100, parts: ["m-Q4_K_M.gguf"], sha256: ["sha-m-Q4_K_M.gguf"] },
      { file: "m.FP16.gguf", quant: "FP16", sizeBytes: 400, parts: ["m.FP16.gguf"], sha256: ["sha-m.FP16.gguf"] },
      { file: "big-Q8_0-00001-of-00002.gguf", quant: "Q8_0", sizeBytes: 1000, parts: ["big-Q8_0-00001-of-00002.gguf", "big-Q8_0-00002-of-00002.gguf"], sha256: ["sha-big-Q8_0-00001-of-00002.gguf", "sha-big-Q8_0-00002-of-00002.gguf"] },
    ]);
  });

  test("a licence not accepted is said, not guessed", async () => {
    const h = hub([{ id: "a/gated", gated: "manual", files: [] }]);
    expect(await listFiles(fetch, h, "a/gated", true, undefined)).toEqual({ error: "This model needs the licence accepted on its page, and a token." });
  });
});

describe("the shape of a model, from the start of its file", () => {
  test("a short start is enough, and the header is asked for again, longer, when it is longer than that", async () => {
    const h = hub([small("a/short"), { ...small("a/long"), header: gguf(([["general.description", { t: "str", v: "x".repeat(600_000) }], ["general.architecture", { t: "str", v: "llama" }], ["llama.block_count", { t: "u32", v: 4 }], ["llama.attention.head_count", { t: "u32", v: 8 }], ["llama.embedding_length", { t: "u32", v: 512 }]] as Parameters<typeof gguf>[0])) }]);
    expect(await readRemoteShape(fetch, h, "a/short", "m-Q4_K_M.gguf", undefined)).toMatchObject({ layers: 32 });
    expect(h.log.filter((l) => l.path.startsWith("/a/short/")).map((l) => l.range)).toEqual(["bytes=0-524287"]);
    expect(await readRemoteShape(fetch, h, "a/long", "m-Q4_K_M.gguf", undefined)).toMatchObject({ layers: 4 });
    expect(h.log.filter((l) => l.path.startsWith("/a/long/")).map((l) => l.range)).toEqual(["bytes=0-524287", "bytes=0-4194303"]);
  });

  test("a file that is not a model says so", async () => {
    const h = hub([{ ...small("a/odd"), header: new Uint8Array(40) }]);
    expect(await readRemoteShape(fetch, h, "a/odd", "m-Q4_K_M.gguf", undefined)).toEqual({ error: "This file is not a GGUF file." });
  });
});

describe("a search", () => {
  test("every file with where it runs, the ones that run best first; one start of a file per repository, not per quant", async () => {
    const h = hub([small("a/one"), small("a/two")]);
    const found = await searchModels(fetch, h, { query: "m", window: 8192, machine: withCard });
    if ("error" in found) throw new Error(found.error);
    expect(found.notes).toEqual([]);
    expect(found.items).toHaveLength(8);
    expect(found.items.map((i) => [i.repo, i.quant, i.fit])).toEqual([
      ["a/one", "Q4_K_M", "gpu"], ["a/two", "Q4_K_M", "gpu"], ["a/one", "Q8_0", "gpu"], ["a/two", "Q8_0", "gpu"], ["a/one", "IQ2_XS", "gpu"], ["a/two", "IQ2_XS", "gpu"], ["a/one", "BF16", "gpu"], ["a/two", "BF16", "gpu"],
    ]);
    expect(h.log.filter((l) => l.path.includes("/resolve/")).length).toBe(2);
    expect(h.log[0]!.path).toContain("filter=gguf&search=m&sort=downloads");
  });

  test("on a laptop the large ones do not fit, and the context asked for is the one the fit is for (never above what the model supports)", async () => {
    const h = hub([small("a/one", { header: llama({ context: 4096 }) })]);
    const found = await searchModels(fetch, h, { query: "m", window: 32768, machine: laptop });
    if ("error" in found) throw new Error(found.error);
    expect(found.items.map((i) => [i.quant, i.fit, i.contextLength])).toEqual([["Q4_K_M", "ram", 4096], ["Q8_0", "ram", 4096], ["IQ2_XS", "ram", 4096], ["BF16", "none", 4096]]);
    expect(found.items.find((i) => i.fit === "none")!.needMb).toBeGreaterThan(16000);
  });

  test("a repository whose header cannot be read is still offered, with no claim of fit", async () => {
    const h = hub([{ ...small("a/odd"), header: new Uint8Array(40) }]);
    const found = await searchModels(fetch, h, { query: "m", window: 8192, machine: laptop });
    if ("error" in found) throw new Error(found.error);
    expect(found.items.every((i) => i.fit === undefined)).toBe(true);
    expect(found.notes).toEqual(["a/odd: This file is not a GGUF file."]);
  });

  test("a kind of model the fit is not proven for is listed with no claim of where it runs", async () => {
    const h = hub([{ ...small("a/ssm"), header: gguf([["general.architecture", { t: "str", v: "mamba" }], ["mamba.block_count", { t: "u32", v: 24 }], ["mamba.attention.head_count", { t: "u32", v: 8 }], ["mamba.embedding_length", { t: "u32", v: 512 }]]) }]);
    const found = await searchModels(fetch, h, { query: "m", window: 8192, machine: withCard });
    if ("error" in found) throw new Error(found.error);
    expect(found.items).toHaveLength(4);
    expect(found.items.every((i) => i.fit === undefined && i.needMb === undefined)).toBe(true);
  });

  test("of the files that run, the ones a person is best served by come first: Q4_K_M before the large full-precision file", async () => {
    const h = hub([small("a/one")]);
    const found = await searchModels(fetch, h, { query: "m", window: 8192, machine: withCard });
    if ("error" in found) throw new Error(found.error);
    expect(found.items[0]!.quant).toBe("Q4_K_M");
    expect(found.items.at(-1)!.quant).toBe("BF16");
  });

  test("a licence: without the token the repository is left out and said; with it the token goes with every question, to the hub only, and is nowhere in the answer", async () => {
    const repos = [small("a/open"), small("a/locked", { gated: "manual" })];
    const h = hub(repos);
    const without = await searchModels(fetch, h, { query: "m", window: 8192, machine: withCard });
    if ("error" in without) throw new Error(without.error);
    expect(without.items.every((i) => i.repo === "a/open")).toBe(true);
    expect(without.notes).toEqual(["a/locked: This model needs the licence accepted on its page, and a token."]);
    const h2 = hub(repos);
    const withToken = await searchModels(fetch, h2, { query: "m", window: 8192, machine: withCard, token: "hf-secret" });
    if ("error" in withToken) throw new Error(withToken.error);
    expect(withToken.items.some((i) => i.repo === "a/locked" && i.gated)).toBe(true);
    expect(h2.log.every((l) => l.auth === "Bearer hf-secret")).toBe(true);
    expect(JSON.stringify(withToken)).not.toContain("hf-secret");
  });

  test("when the hub says few questions are left, the rest is left out and said, with the seconds to the next window", async () => {
    let left = 400;
    const repos = Array.from({ length: 9 }, (_, i) => small(`a/r${i}`));
    const h = hub(repos, { remaining: () => (left -= 20) > 0 ? 6 : 0 });
    const found = await searchModels(fetch, h, { query: "m", window: 8192, machine: withCard });
    if ("error" in found) throw new Error(found.error);
    expect(new Set(found.items.map((i) => i.repo)).size).toBeLessThan(9);
    expect(found.notes.at(-1)).toMatch(/^\d+ more were left out: the model hub allows only a few more questions for now \(200 seconds to the next window\)\.$/);
  });

  test("a hub that asks to wait, and one that cannot be reached, answer in one sentence", async () => {
    expect(await searchModels(fetch, hub([small("a/b")], { status429: true }), { query: "m", window: 8192, machine: laptop })).toEqual({ error: "The model hub asked to wait 42 seconds before more questions.", retryAfterSeconds: 42 });
    expect(await searchModels(fetch, { base: "http://127.0.0.1:1" }, { query: "m", window: 8192, machine: laptop })).toEqual({ error: "The model hub could not be reached." });
  });
});

describe("what the hub says of its limits", () => {
  test("the kind of question, how many are left and the seconds to the reset", () => {
    expect(rateOf(new Response("", { headers: { ratelimit: '"api";r=498;t=83' } }))).toEqual({ kind: "api", remaining: 498, resetSeconds: 83 });
    expect(rateOf(new Response(""))).toBeUndefined();
  });
});

describe("the models to start with", () => {
  const TOOLS = "{%- if tools %}{{ tools }}{%- endif %}";
  const model = (id: string, extra: Partial<Repo> = {}): Repo => ({ ...small(id), template: TOOLS, ...extra });

  test("only a model whose template handles tools, one file of each (the best-liked quant that fits), the card first and then the order given", async () => {
    const h = hub([model("a/first", { files: [{ path: "m-Q4_K_M.gguf", size: 30000 * MB }, { path: "m-IQ2_XS.gguf", size: 9000 * MB }] }), model("a/second"), model("a/talker", { template: "{{ messages }}" }), model("a/unsaid", { template: undefined })]);
    const found = await recommendedModels(fetch, h, ["a/first", "a/second", "a/talker", "a/unsaid", "a/missing"], { window: 8192, machine: withCard });
    expect(found.items.map((i) => [i.repo, i.quant, i.fit, i.tools])).toEqual([["a/first", "IQ2_XS", "gpu", true], ["a/second", "Q4_K_M", "gpu", true]]);
    expect(found.notes).toEqual(["a/missing: The model hub answered 404."]);
    const small8: Machine = { ...withCard, gpus: [{ ...withCard.gpus[0]!, memoryMb: 8000, freeMb: 8000 }] };
    const ranked = await recommendedModels(fetch, h, ["a/first", "a/second"], { window: 8192, machine: small8 });
    expect(ranked.items.map((i) => [i.repo, i.fit])).toEqual([["a/second", "gpu"], ["a/first", "ram"]]);
  });

  test("nothing that does not fit is offered, and the list is no longer than asked", async () => {
    const big = model("a/big", { files: [{ path: "m-Q4_K_M.gguf", size: 60000 * MB }] });
    expect((await recommendedModels(fetch, hub([big]), ["a/big"], { window: 8192, machine: laptop })).items).toEqual([]);
    const many = ["a/1", "a/2", "a/3", "a/4", "a/5"].map((id) => model(id));
    const found = await recommendedModels(fetch, hub(many), many.map((m) => m.id), { window: 8192, machine: withCard, limit: 4 });
    expect(found.items.map((i) => i.repo)).toEqual(["a/1", "a/2", "a/3", "a/4"]);
  });
});
