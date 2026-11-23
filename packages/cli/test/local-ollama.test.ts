import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { validateCommand } from "@navvied/protocol";
import { createHub } from "../src/commands/hub.ts";
import { configPath } from "../src/config.ts";
import { ollamaRoot } from "../src/ollama-pull.ts";
import { fakeIO, remove, tempDir, until } from "./helpers.ts";

const dirs: string[] = [];
afterAll(() => dirs.forEach(remove));

type Ev = { ev: string; state?: string; model?: string; bytes?: number; total?: number; error?: string; msg?: string; baseUrl?: string; version?: string; models?: { name: string; tools?: boolean }[] };

interface Fake { fetchFn: typeof fetch; calls: string[]; finish(): void }

/** An Ollama that answers `version`, `tags` and a stream on `pull` that is told line by line. */
function ollama(o: { up?: boolean; lines?: string[]; hold?: boolean; endWithout?: boolean } = {}): Fake {
  const calls: string[] = [];
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => { release = r; });
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push(`${init?.method ?? "GET"} ${u}${init?.body ? ` ${String(init.body)}` : ""}`);
    if (o.up === false) throw new Error("refused");
    if (u.endsWith("/api/version")) return Response.json({ version: "0.9.0" });
    if (u.endsWith("/api/tags")) return Response.json({ models: [{ name: "b:1b" }, { name: "a:2b" }, { name: "c:3b" }] });
    if (u.endsWith("/api/show")) { const name = JSON.parse(String(init?.body)).model; return name === "a:2b" ? Response.json({ capabilities: ["completion", "tools"] }) : name === "b:1b" ? Response.json({ capabilities: ["completion"] }) : new Response("", { status: 404 }); }
    if (u.endsWith("/api/pull")) {
      const enc = new TextEncoder();
      const body = new ReadableStream({
        async start(c) {
          init?.signal?.addEventListener("abort", () => { try { c.error(new DOMException("aborted", "AbortError")); } catch { /* ended */ } });
          for (const l of o.lines ?? []) c.enqueue(enc.encode(`${l}\n`));
          if (o.hold) await gate;
          try { c.close(); } catch { /* aborted */ }
        },
      });
      return new Response(body, { status: 200 });
    }
    return new Response("", { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchFn, calls, finish: () => release() };
}

function computer(fetchFn: typeof fetch, o: { cloud?: boolean; env?: Record<string, string> } = {}) {
  const state = tempDir(), work = tempDir();
  dirs.push(state, work);
  const env = { HOME: state, XDG_STATE_HOME: state, XDG_CONFIG_HOME: state, NAVVIED_GUEST_MODELS: "0", ...o.env };
  const file = configPath(env);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ models: { m: { baseUrl: "http://127.0.0.1:1/v1", model: "x", window: 1000 } } }), { mode: 0o600 });
  const hub = createHub({ json: false, yes: false, thinking: false, cwd: work, ...(o.cloud ? { sandboxed: true } : {}) } as never, fakeIO({ env, fetch: fetchFn }).io, { watch: false, import: false });
  const got: Ev[] = [];
  hub.attach({ send: (line) => { got.push(JSON.parse(String(line))); } }, 0);
  return { got, send: (cmd: object) => hub.command(JSON.stringify(cmd), () => undefined), models: (state: string) => got.filter((x) => x.ev === "local.ollama.model" && x.state === state), stop: () => hub.stop() };
}

const line = (j: object): string => JSON.stringify(j);

describe("where Ollama is", () => {
  test("its own setting is read as an address on this computer, and nothing else", () => {
    expect(ollamaRoot({})).toBe("http://127.0.0.1:11434");
    expect(ollamaRoot({ OLLAMA_HOST: "0.0.0.0:9999" })).toBe("http://127.0.0.1:9999");
    expect(ollamaRoot({ OLLAMA_HOST: ":8123" })).toBe("http://127.0.0.1:8123");
    expect(ollamaRoot({ OLLAMA_HOST: "localhost" })).toBe("http://localhost:11434");
    expect(ollamaRoot({ OLLAMA_HOST: "https://box.local:1234" })).toBe("https://box.local:1234");
    expect(ollamaRoot({ OLLAMA_HOST: "not a host" })).toBe("http://127.0.0.1:11434");
  });
});

describe("what a page may send", () => {
  test("the name Ollama knows a model by, and nothing that reaches outside", () => {
    for (const model of ["qwen2.5-coder:1.5b", "hf.co/Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF:Q4_K_M", "llama3.2"]) expect(validateCommand({ cmd: "local.ollama.pull", model }).ok).toBe(true);
    for (const model of ["", "../x", "a b", "-x", "x".repeat(200), 3]) expect(validateCommand({ cmd: "local.ollama.pull", model }).ok).toBe(false);
    expect(validateCommand({ cmd: "local.ollama" }).ok).toBe(true);
    expect(validateCommand({ cmd: "local.ollama.cancel", model: "a:1b" }).ok).toBe(true);
  });
});

describe("local.ollama", () => {
  test("says where Ollama is, its version and the models it keeps", async () => {
    const c = computer(ollama().fetchFn);
    c.send({ cmd: "local.ollama" });
    await until(() => c.got.some((e) => e.ev === "local.ollama"));
    expect(c.got.find((e) => e.ev === "local.ollama")).toMatchObject({ state: "ready", baseUrl: "http://127.0.0.1:11434", version: "0.9.0", models: [{ name: "a:2b", tools: true }, { name: "b:1b", tools: false }, { name: "c:3b" }] });
    await c.stop();
  });

  test("says missing when nothing answers", async () => {
    const c = computer(ollama({ up: false }).fetchFn);
    c.send({ cmd: "local.ollama" });
    await until(() => c.got.some((e) => e.ev === "local.ollama"));
    expect(c.got.find((e) => e.ev === "local.ollama")).toMatchObject({ ev: "local.ollama", state: "missing" });
    await c.stop();
  });
});

describe("local.ollama.pull", () => {
  test("progress is the sum of the layers, and the model is in the list when it is done", async () => {
    const f = ollama({ lines: [line({ status: "pulling manifest" }), line({ status: "pulling aa", digest: "sha256:aa", total: 1000, completed: 100 }), line({ status: "pulling bb", digest: "sha256:bb", total: 200, completed: 0 }), line({ status: "pulling aa", digest: "sha256:aa", total: 1000, completed: 1000 }), line({ status: "verifying sha256 digest" }), line({ status: "success" })] });
    const c = computer(f.fetchFn);
    c.send({ cmd: "local.ollama.pull", model: "qwen2.5-coder:1.5b" });
    await until(() => c.models("done").length === 1);
    expect(c.models("downloading").map((e) => [e.bytes, e.total])).toEqual([[0, 0], [100, 1000], [100, 1200], [1000, 1200]]);
    expect(c.models("verifying").map((e) => [e.bytes, e.total])).toEqual([[1000, 1200]]);
    expect(f.calls.find((x) => x.includes("/api/pull"))).toBe('POST http://127.0.0.1:11434/api/pull {"model":"qwen2.5-coder:1.5b","stream":true}');
    await until(() => c.got.some((e) => e.ev === "local.ollama"));
    await c.stop();
  });

  test("an error line of Ollama is said in words and is the end", async () => {
    const c = computer(ollama({ lines: [line({ status: "pulling manifest" }), line({ error: "pull model manifest: file does not exist" })] }).fetchFn);
    c.send({ cmd: "local.ollama.pull", model: "nope:1b" });
    await until(() => c.models("failed").length === 1);
    expect(c.models("failed")[0]!.error).toBe("Ollama said: pull model manifest: file does not exist");
    expect(c.models("done")).toHaveLength(0);
    await c.stop();
  });

  test("a stream that ends before success is a failure that says how to go on", async () => {
    const c = computer(ollama({ lines: [line({ status: "pulling aa", digest: "sha256:aa", total: 10, completed: 5 })] }).fetchFn);
    c.send({ cmd: "local.ollama.pull", model: "a:1b" });
    await until(() => c.models("failed").length === 1);
    expect(c.models("failed")[0]!.error).toContain("Pull again to go on where it stopped");
    await c.stop();
  });

  test("a refusal with a reason says the reason, not only the number", async () => {
    const f = ollama();
    const asking = (async (url: string | URL | Request, init?: RequestInit) => (String(url).endsWith("/api/pull") ? new Response(JSON.stringify({ error: "invalid model name" }), { status: 400 }) : f.fetchFn(url, init))) as unknown as typeof fetch;
    const c = computer(asking);
    c.send({ cmd: "local.ollama.pull", model: "a:1b" });
    await until(() => c.models("failed").length === 1);
    expect(c.models("failed")[0]!.error).toBe("Ollama said: invalid model name");
    await c.stop();
  });

  test("Ollama not running is said at once", async () => {
    const c = computer(ollama({ up: false }).fetchFn);
    c.send({ cmd: "local.ollama.pull", model: "a:1b" });
    await until(() => c.models("failed").length === 1);
    expect(c.models("failed")[0]!.error).toBe("Ollama could not be reached. Start it and try again.");
    await c.stop();
  });

  test("a cancel closes the request and says idle; a second pull of the same model while one goes on starts nothing", async () => {
    const f = ollama({ hold: true, lines: [line({ status: "pulling aa", digest: "sha256:aa", total: 10, completed: 5 })] });
    const c = computer(f.fetchFn);
    c.send({ cmd: "local.ollama.pull", model: "a:1b" });
    await until(() => c.models("downloading").length === 1);
    c.send({ cmd: "local.ollama.pull", model: "a:1b" });
    expect(f.calls.filter((x) => x.includes("/api/pull"))).toHaveLength(1);
    c.send({ cmd: "local.ollama.cancel", model: "a:1b" });
    await until(() => c.models("idle").length === 1);
    expect(c.models("failed")).toHaveLength(0);
    f.finish();
    await c.stop();
  });
});

describe("in a cloud session", () => {
  test("every one of them is refused and nothing is asked of any server", async () => {
    const f = ollama();
    const c = computer(f.fetchFn, { cloud: true });
    for (const cmd of [{ cmd: "local.ollama" }, { cmd: "local.ollama.pull", model: "a:1b" }, { cmd: "local.ollama.cancel", model: "a:1b" }]) c.send(cmd);
    await until(() => c.got.filter((e) => e.ev === "error").length === 3);
    expect(f.calls).toEqual([]);
    await c.stop();
  });
});
