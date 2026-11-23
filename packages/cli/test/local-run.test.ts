import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { validateCommand } from "@navvied/protocol";
import { createHub } from "../src/commands/hub.ts";
import { configPath, loadConfig, localDir, resolveModel } from "../src/config.ts";
import { serverNote } from "../src/local-entry.ts";
import { readMachine, realProbe } from "../src/machine.ts";
import { RUNTIME, RUNTIME_DRIVERS } from "../src/presets.ts";
import { pickAsset } from "../src/runtime.ts";
import { fakeIO, remove, tempDir, until } from "./helpers.ts";
import { llama } from "./gguf-builder.ts";

const dirs: string[] = [];
const hubs: { stop(): Promise<void> }[] = [];
afterAll(async () => { for (const h of hubs) await h.stop(); dirs.forEach(remove); });
const win = process.platform === "win32";

type Ev = { ev: string; state?: string; backend?: string; server?: string; repo?: string; file?: string; error?: string; window?: number; layers?: number; msg?: string; text?: string; models?: { id: string; handover?: boolean; current?: boolean }[]; items?: { repo: string; file: string; state: string }[] };

const REPO = "org/tiny", FILE = "tiny-Q4_K_M.gguf";

/** A computer with a runtime that is ready (a stand-in for the model server, in the folder a real one would be in) and one model on it. */
async function computer(o: { cloud?: false | "flag"; runtime?: boolean; model?: boolean; stale?: boolean; backend?: "cpu" } = {}) {
  const state = tempDir(), work = tempDir();
  dirs.push(state, work);
  const env: Record<string, string> = { HOME: state, XDG_STATE_HOME: state, XDG_CONFIG_HOME: state, NAVVIED_GUEST_MODELS: "0", ...(o.backend ? { NAVVIED_LOCAL_BACKEND: o.backend } : {}) };
  const local = localDir(env);
  if (o.runtime !== false) {
    const m = await readMachine(realProbe({ run: async () => ({ code: 1, output: "" }) }), local);
    const a = pickAsset(RUNTIME, m, RUNTIME_DRIVERS, o.backend)!;
    const folder = join(local, "runtime", RUNTIME.tag, `${a.os}-${a.arch}-${a.backend}`);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "llama-server"), `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dir, "fake-llama.ts")}" "$@"\n`);
    chmodSync(join(folder, "llama-server"), 0o755);
    writeFileSync(join(folder, "installed.json"), JSON.stringify({ tag: RUNTIME.tag, commit: RUNTIME.commit, backend: a.backend, binary: "llama-server", files: [{ file: a.file, sha256: a.sha256 }] }));
  }
  if (o.model !== false) {
    const bytes = llama({ layers: 4, heads: 8, kvHeads: 2, embed: 512, context: 131072, template: "{% if tools %}{{ tools }}{% endif %}" });
    const at = join(local, "models", "org--tiny", FILE);
    mkdirSync(dirname(at), { recursive: true });
    writeFileSync(at, bytes);
    writeFileSync(join(local, "models", "installed.json"), JSON.stringify([{ repo: REPO, file: FILE, quant: "Q4_K_M", sizeBytes: 300_000_000, parts: [FILE], sha256: ["x"] }]));
  }
  const file = configPath(env);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ models: { m: { baseUrl: "http://127.0.0.1:1/v1", model: "x", window: 1000 }, ...(o.stale ? { "local-old": { local: { repo: REPO, file: FILE, window: 8192 }, model: "old" } } : {}) } }));
  const hub = createHub({ json: false, yes: false, thinking: false, cwd: work, ...(o.cloud === "flag" ? { sandboxed: true } : {}) } as never, fakeIO({ env }).io, { watch: false, import: false });
  hubs.push(hub);
  const got: Ev[] = [];
  hub.attach({ send: (line) => { got.push(JSON.parse(String(line))); } }, 0);
  const of = (ev: string, state?: string) => got.filter((e) => e.ev === ev && (state === undefined || e.state === state));
  const names = (): string[] => (got.filter((e) => e.ev === "caps").at(-1)?.models ?? []).map((m) => m.id);
  const resolve = (name: string) => { const f = loadConfig(file); if (!f.ok) throw new Error(f.error); return resolveModel(name, f.value, env, file); };
  return { env, local, file, hub, got, of, names, resolve, send: (cmd: object) => hub.command(JSON.stringify(cmd), () => undefined) };
}

const NAME = "local-org-tiny-tiny-q4_k_m";

describe("what a page may send", () => {
  test("a model of a repository, a context of a usual size or none, and a stop", () => {
    expect(validateCommand({ cmd: "local.run", repo: REPO, file: FILE }).ok).toBe(true);
    expect(validateCommand({ cmd: "local.run", repo: REPO, file: FILE, window: 16384 }).ok).toBe(true);
    expect(validateCommand({ cmd: "local.run", repo: REPO, file: "../x.gguf" }).ok).toBe(false);
    expect(validateCommand({ cmd: "local.run", repo: REPO, file: FILE, window: 3 }).ok).toBe(false);
    expect(validateCommand({ cmd: "local.stop" }).ok).toBe(true);
  });
});

describe.skipIf(win)("the model server of this computer", () => {
  test("started, it is ready when it listens: the page is told, its model is in the list at once, and a conversation goes through it", async () => {
    const c = await computer();
    await until(() => c.of("caps").length > 0);
    expect(c.names()).toEqual(["m"]);
    c.send({ cmd: "local.run", repo: REPO, file: FILE });
    await until(() => c.of("local.server", "running").length === 1, 20_000);
    expect(c.of("local.server", "starting")[0]).toMatchObject({ repo: REPO, file: FILE, window: 32768 });
    await until(() => c.names().includes(NAME));
    expect(c.of("caps").at(-1)!.models!.find((m) => m.id === NAME)).toMatchObject({ handover: true, tools: true });
    expect(c.of("local.file", "running")).toHaveLength(1);
    c.send({ cmd: "local.models" });
    await until(() => c.of("local.installed").length > 0);
    expect(c.of("local.installed").at(-1)!.items![0]).toMatchObject({ repo: REPO, file: FILE, tools: true });
    const resolved = c.resolve(NAME);
    if (!resolved.ok) throw new Error(resolved.error);
    expect(resolved.value).toMatchObject({ api: "chat", window: 32768, provider: { model: "tiny-Q4_K_M" } });
    expect(resolved.value.provider!.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    expect(await (await fetch(`${resolved.value.provider!.baseUrl.replace("/v1", "")}/health`)).json()).toEqual({ status: "ok" });
    // The address is not kept in the configuration: it is a different one at each start.
    expect(JSON.stringify(JSON.parse(await Bun.file(c.file).text()).models[NAME])).not.toContain("127.0.0.1");
    c.send({ cmd: "model", id: NAME });
    await until(() => c.of("notice").length === 1, 20_000);
    c.send({ cmd: "prompt", text: "hi", mode: "auto", qid: "q1" });
    await until(() => c.of("done").length === 1, 20_000);
    expect(JSON.stringify(c.got.filter((e) => e.ev === "text" || e.ev === "message"))).toContain("hello");
    expect(c.of("error")).toEqual([]);
  });

  test("stopped, the process is gone, the note is gone, the model leaves the list, and it refuses in words", async () => {
    const c = await computer();
    c.send({ cmd: "local.run", repo: REPO, file: FILE });
    await until(() => c.of("local.server", "running").length === 1, 20_000);
    const note = JSON.parse(await Bun.file(serverNote(c.local)).text()) as { pid: number };
    c.send({ cmd: "local.stop" });
    await until(() => c.of("local.server", "stopped").length === 1, 20_000);
    expect(() => process.kill(note.pid, 0)).toThrow();
    expect(existsSync(serverNote(c.local))).toBe(false);
    await until(() => !c.names().includes(NAME));
    expect(c.resolve(NAME)).toEqual({ ok: false, error: "tiny-Q4_K_M is not running. Start it first." });
  });

  test("the runtime is taken away only when no model runs, the models stay, and the state is none", async () => {
    const c = await computer();
    c.send({ cmd: "local.run", repo: REPO, file: FILE });
    await until(() => c.of("local.server", "running").length === 1, 20_000);
    c.send({ cmd: "local.runtime.remove" });
    await until(() => c.of("error").length === 1);
    expect(c.of("error")[0]!.msg).toBe("A model is running. Stop it first.");
    expect(existsSync(join(c.local, "runtime"))).toBe(true);
    c.send({ cmd: "local.stop" });
    await until(() => c.of("local.server", "stopped").length === 1, 20_000);
    const before = c.of("local.runtime").length;
    c.send({ cmd: "local.runtime.remove" });
    await until(() => c.of("local.runtime").length > before);
    expect(c.of("local.runtime").at(-1)).toMatchObject({ state: "none", server: "stopped" });
    expect(existsSync(join(c.local, "runtime"))).toBe(false);
    expect(existsSync(join(c.local, "models", "org--tiny", FILE))).toBe(true);
    c.send({ cmd: "local.run", repo: REPO, file: FILE });
    await until(() => c.of("local.server", "failed").length === 1);
    expect(c.of("local.server", "failed")[0]!.error).toBe("The runtime is not fetched yet.");
  });

  test("a build for the processor is planned as if the computer had no card: no layer goes to a card that the build cannot use", async () => {
    const argsFile = join(tempDir(), "args.json");
    dirs.push(dirname(argsFile));
    process.env.FAKE_LLAMA_ARGS = argsFile;
    try {
      const c = await computer({ backend: "cpu" });
      c.send({ cmd: "local.run", repo: REPO, file: FILE });
      await until(() => c.of("local.server", "running").length === 1, 20_000);
      expect(c.of("local.server", "running")[0]).toMatchObject({ layers: 0 });
      const given = JSON.parse(await Bun.file(argsFile).text()) as { args: string[] };
      expect(given.args[given.args.indexOf("-ngl") + 1]).toBe("0");
      c.send({ cmd: "local.runtime" });
      await until(() => c.of("local.runtime").length === 1);
      expect(c.of("local.runtime")[0]).toMatchObject({ state: "ready", backend: "cpu", server: "running" });
    } finally { delete process.env.FAKE_LLAMA_ARGS; }
  });

  test("another model replaces the one that runs: one server at a time", async () => {
    const c = await computer();
    c.send({ cmd: "local.run", repo: REPO, file: FILE });
    await until(() => c.of("local.server", "running").length === 1, 20_000);
    const first = JSON.parse(await Bun.file(serverNote(c.local)).text()) as { pid: number };
    c.send({ cmd: "local.run", repo: REPO, file: FILE, window: 8192 });
    await until(() => c.of("local.server", "running").length === 2, 20_000);
    const second = JSON.parse(await Bun.file(serverNote(c.local)).text()) as { pid: number };
    expect(second.pid).not.toBe(first.pid);
    expect(() => process.kill(first.pid, 0)).toThrow();
    expect(c.of("local.server", "running")[1]).toMatchObject({ window: 8192 });
  });

  test("the hub ending ends the server with it", async () => {
    const c = await computer();
    c.send({ cmd: "local.run", repo: REPO, file: FILE });
    await until(() => c.of("local.server", "running").length === 1, 20_000);
    const note = JSON.parse(await Bun.file(serverNote(c.local)).text()) as { pid: number };
    await c.hub.stop();
    expect(() => process.kill(note.pid, 0)).toThrow();
  });

  test("a program that does not start, no runtime yet, and a model that is not here each say so, and no model is made", async () => {
    process.env.FAKE_LLAMA = "fail";
    try {
      const c = await computer();
      c.send({ cmd: "local.run", repo: REPO, file: FILE });
      await until(() => c.of("local.server", "failed").length === 1, 20_000);
      expect(c.of("local.server", "failed")[0]!.error).toBe("The model did not start: srv load_model: error: failed to load model, out of memory");
      expect(c.names()).not.toContain(NAME);
    } finally { delete process.env.FAKE_LLAMA; }
    const none = await computer({ runtime: false });
    none.send({ cmd: "local.run", repo: REPO, file: FILE });
    await until(() => none.of("local.server", "failed").length === 1);
    expect(none.of("local.server", "failed")[0]!.error).toBe("The runtime is not fetched yet.");
    const missing = await computer({ model: false });
    missing.send({ cmd: "local.run", repo: REPO, file: FILE });
    await until(() => missing.of("local.server", "failed").length === 1);
    expect(missing.of("local.server", "failed")[0]!.error).toBe("That model is not on this computer.");
  });

  test("a model of the server that is not running is not offered, even when a program that crashed left it in the configuration", async () => {
    const c = await computer({ stale: true });
    await until(() => c.of("caps").length > 0);
    expect(c.names()).toEqual(["m"]);
    expect(c.resolve("local-old")).toEqual({ ok: false, error: "old is not running. Start it first." });
  });

  test("in Navvied Cloud both are refused and nothing is started", async () => {
    const c = await computer({ cloud: "flag" });
    c.send({ cmd: "local.run", repo: REPO, file: FILE });
    c.send({ cmd: "local.stop" });
    await until(() => c.of("error").length === 2);
    expect(c.of("error").every((e) => e.msg?.includes("never in Navvied Cloud"))).toBe(true);
    expect(existsSync(serverNote(c.local))).toBe(false);
  });
});
