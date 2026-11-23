import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { validateCommand } from "@navvied/protocol";
import { createHub } from "../src/commands/hub.ts";
import { configPath, localDir } from "../src/config.ts";
import { readMachine, realProbe } from "../src/machine.ts";
import { RUNTIME, RUNTIME_DRIVERS } from "../src/presets.ts";
import { pickAsset } from "../src/runtime.ts";
import { fakeIO, remove, tempDir, until } from "./helpers.ts";

const dirs: string[] = [];
afterAll(() => { dirs.forEach(remove); });

type Ev = { ev: string; state?: string; version?: string; backend?: string; error?: string; bytes?: number; total?: number; msg?: string };

function computer(o: { cloud?: false | "flag" | "config" } = {}) {
  const state = tempDir(), work = tempDir();
  dirs.push(state, work);
  const env = { HOME: state, XDG_STATE_HOME: state, XDG_CONFIG_HOME: state, NAVVIED_GUEST_MODELS: "0" };
  const file = configPath(env);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ models: { m: { baseUrl: "http://127.0.0.1:1/v1", model: "x", window: 1000 } }, ...(o.cloud === "config" ? { webProxy: { url: "http://127.0.0.1:1/v1/web", token: "t" } } : {}) }));
  const asked: string[] = [];
  const fetchFn = (async (url: string | URL | Request) => { asked.push(String(url)); return new Response("", { status: 404 }); }) as unknown as typeof fetch;
  const io = fakeIO({ env, fetch: fetchFn });
  const hub = createHub({ json: false, yes: false, thinking: false, cwd: work, ...(o.cloud === "flag" ? { sandboxed: true } : {}) } as never, io.io, { watch: false, import: false });
  const got: Ev[] = [];
  hub.attach({ send: (line) => { got.push(JSON.parse(String(line))); } }, 0);
  return { env, asked, got, send: (cmd: object) => hub.command(JSON.stringify(cmd), () => undefined), ran: () => (io.io.system as unknown as { ran: string[][] }).ran };
}

describe("what a page may send", () => {
  test("three plain commands", () => {
    for (const cmd of ["local.runtime", "local.runtime.install", "local.runtime.cancel"]) expect(validateCommand({ cmd }).ok).toBe(true);
  });
});

describe("the runtime through the hub", () => {
  test("not there yet: the state says none and which release it is pinned to", async () => {
    const c = computer();
    c.send({ cmd: "local.runtime" });
    await until(() => c.got.some((e) => e.ev === "local.runtime"));
    expect(c.got.find((e) => e.ev === "local.runtime")).toMatchObject({ state: "none", version: RUNTIME.tag });
  });

  test("there: a build that was fetched and written down is ready, with the backend it is", async () => {
    const c = computer();
    const m = await readMachine(realProbe({ run: async () => ({ code: 1, output: "" }) }), localDir(c.env));
    const asset = pickAsset(RUNTIME, m, RUNTIME_DRIVERS)!;
    const dir = join(localDir(c.env), "runtime", RUNTIME.tag, `${asset.os}-${asset.arch}-${asset.backend}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "llama-server"), "x");
    writeFileSync(join(dir, "installed.json"), JSON.stringify({ tag: RUNTIME.tag, commit: RUNTIME.commit, backend: asset.backend, binary: "llama-server", files: [{ file: asset.file, sha256: asset.sha256 }] }));
    c.send({ cmd: "local.runtime" });
    await until(() => c.got.some((e) => e.ev === "local.runtime"));
    expect(c.got.find((e) => e.ev === "local.runtime")).toMatchObject({ state: "ready", backend: asset.backend });
  });

  test("fetched from the release's own address, and a release that does not have the file: the way it fails is said, nothing is run", async () => {
    const c = computer();
    c.send({ cmd: "local.runtime.install" });
    await until(() => c.got.some((e) => e.ev === "local.runtime" && e.state === "failed"), 20_000);
    expect(c.got.find((e) => e.ev === "local.runtime" && e.state === "failed")).toMatchObject({ error: "The server answered 404.", version: RUNTIME.tag });
    expect(c.asked).toHaveLength(1);
    expect(c.asked[0]!.startsWith(`${RUNTIME.base}/${RUNTIME.tag}/`)).toBe(true);
    // The machine was read with its own tools; the unpacking tool and the program were not run.
    expect(c.ran().filter((argv) => argv[0] === "tar" || argv[0]!.includes("llama-server"))).toEqual([]);
    c.send({ cmd: "local.runtime" });
    await until(() => c.got.filter((e) => e.ev === "local.runtime").length === 2);
    expect(c.got.filter((e) => e.ev === "local.runtime").at(-1)).toMatchObject({ state: "failed", error: "The server answered 404." });
  });

  test("in Navvied Cloud every one of these is refused and nothing is fetched", async () => {
    for (const how of ["flag", "config"] as const) {
      const c = computer({ cloud: how });
      for (const cmd of ["local.runtime", "local.runtime.install", "local.runtime.cancel"]) c.send({ cmd });
      await until(() => c.got.filter((e) => e.ev === "error").length === 3);
      expect(c.got.filter((e) => e.ev === "error").every((e) => e.msg?.includes("never in Navvied Cloud"))).toBe(true);
      expect(c.asked).toEqual([]);
    }
  });
});
