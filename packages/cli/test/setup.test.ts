import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { autoUpdate } from "../src/commands/auto-update.ts";
import { findLocalServers, reachable } from "../src/model-setup.ts";
import { assetName, detectMachine, isInstalledProgram, progressLine, releaseBase, updateCommand, updateProgram, type UpdateProgress } from "../src/commands/update.ts";
import { loadConfig } from "../src/config.ts";
import { main } from "../src/main.ts";
import { fakeIO, remove, tempDir } from "./helpers.ts";

const dirs: string[] = [];
const tmp = (): string => { const d = tempDir(); dirs.push(d); return d; };
afterAll(() => dirs.forEach(remove));

const localFetch = (servers: Record<number, string[]>, up = true): typeof fetch =>
  (async (input: string | URL | Request) => {
    const url = String(input);
    const port = Number(/:(\d+)\//.exec(url)?.[1]);
    if (url.endsWith("/models") && servers[port]) return Response.json({ data: servers[port].map((id) => ({ id })) });
    if (url.endsWith("/api/tags") && servers[port]) return Response.json({ models: servers[port].map((name) => ({ name })) });
    if (url.endsWith("/api/show") && servers[port]) return Response.json({ model_info: { "llama.context_length": 8192 } });
    if (url.includes("hosted.example") && up) return new Response("{}");
    throw new Error("connection refused");
  }) as unknown as typeof fetch;

function setup(stdin: string, fetchFn: typeof fetch = localFetch({})) {
  const state = tmp();
  const config = join(state, "config.json");
  const f = fakeIO({ interactive: true, stdin, env: { HOME: state, XDG_STATE_HOME: state, PATH: process.env.PATH ?? "" }, fetch: fetchFn });
  return { f, config, state };
}
const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));

describe("finding local model servers", () => {
  test("probes the usual ports and lists their models", async () => {
    const found = await findLocalServers(localFetch({ 11434: ["a", "b"], 1234: ["c"] }));
    expect(found).toEqual([{ name: "Ollama", baseUrl: "http://127.0.0.1:11434/v1", models: ["a", "b"], ollama: true }, { name: "LM Studio", baseUrl: "http://127.0.0.1:1234/v1", models: ["c"] }]);
  });
  test("nothing running, a refused connection or a non-OK answer → nothing found", async () => {
    expect(await findLocalServers(localFetch({}))).toEqual([]);
    expect(await findLocalServers((async () => new Response("no", { status: 500 })) as unknown as typeof fetch)).toEqual([]);
  });
});

describe("reachable", () => {
  test("sends the key and reports the outcome", async () => {
    const seen = { auth: null as string | null };
    const f = (async (_u: string, init?: RequestInit) => { seen.auth = new Headers(init?.headers).get("authorization"); return new Response("{}"); }) as unknown as typeof fetch;
    expect(await reachable({ baseUrl: "http://h/v1", model: "m", apiKeyEnv: "K" }, { K: "tok" }, f)).toBe(true);
    expect(seen.auth).toBe("Bearer tok");
    expect(await reachable({ baseUrl: "http://h/v1", model: "m" }, {}, (async () => new Response("", { status: 401 })) as unknown as typeof fetch)).toBe(false);
    expect(await reachable({ command: "x" }, {}, f)).toBe(false);
  });
});

describe("navvied update", () => {
  let server: ReturnType<typeof Bun.serve>;
  let files: Record<string, string> = {};
  beforeAll(() => { server = Bun.serve({ port: 0, fetch(req) { const body = files[new URL(req.url).pathname]; return body === undefined ? new Response("nope", { status: 404 }) : new Response(body); } }); });
  afterAll(() => server.stop(true));

  const sha = (t: string) => new Bun.CryptoHasher("sha256").update(t).digest("hex");
  const publish = (program: string, sum = sha(program)) => { files = { "/rel/navvied-linux-x64": program, "/rel/SHA256SUMS": `${sum}  navvied-linux-x64\n` }; };
  const target = (exe: string) => ({ base: `http://127.0.0.1:${server.port}/rel`, os: "linux" as const, arch: "x64" as const, variant: "" as const, exe, fetch });
  const installed = (text: string): string => { const exe = join(tmp(), "navvied"); writeFileSync(exe, text); chmodSync(exe, 0o755); return exe; };

  test("replaces the program with the new release, verified, executable", async () => {
    const exe = installed("old program");
    publish("new program");
    expect(await updateProgram(target(exe))).toBe("updated");
    expect(readFileSync(exe, "utf8")).toBe("new program");
    if (process.platform !== "win32") expect(statSync(exe).mode & 0o111).not.toBe(0);
    expect(existsSync(`${exe}.new`)).toBe(false);
  });
  test("already the latest → nothing is downloaded or changed", async () => {
    const exe = installed("same");
    publish("same");
    delete files["/rel/navvied-linux-x64"];
    expect(await updateProgram(target(exe))).toBe("current");
  });
  test("a checksum mismatch leaves the installed program untouched", async () => {
    const exe = installed("keep me");
    publish("tampered", "0".repeat(64));
    await expect(updateProgram(target(exe))).rejects.toThrow(/checksum mismatch.*not changed/);
    expect(readFileSync(exe, "utf8")).toBe("keep me");
  });
  test("a missing release or checksum entry is an error with the address", async () => {
    const exe = installed("x");
    files = {};
    await expect(updateProgram(target(exe))).rejects.toThrow(/could not download .*SHA256SUMS \(404\)/);
    files = { "/rel/SHA256SUMS": "abc  navvied-darwin-arm64\n" };
    await expect(updateProgram(target(exe))).rejects.toThrow(/no checksum is listed for navvied-linux-x64/);
  });
  test("release addresses, with and without a pinned version", () => {
    expect(releaseBase({})).toBe("https://github.com/navvied/navvied-agent/releases/latest/download");
    expect(releaseBase({}, "v1.2.0")).toBe("https://github.com/navvied/navvied-agent/releases/download/v1.2.0");
    expect(releaseBase({ NAVVIED_RELEASE_URL: "http://m/rel" }, "v1")).toBe("http://m/rel/v1");
  });
  test("on Windows the running program is renamed aside, then replaced; the next update clears the old copy", async () => {
    files = { "/rel/navvied-windows-x64.exe": "new exe", "/rel/SHA256SUMS": `${sha("new exe")}  navvied-windows-x64.exe\n` };
    const exe = join(tmp(), "navvied.exe");
    writeFileSync(exe, "old exe");
    expect(await updateProgram({ ...target(exe), os: "windows" })).toBe("updated");
    expect(readFileSync(exe, "utf8")).toBe("new exe");
    expect(readFileSync(`${exe}.old`, "utf8")).toBe("old exe");
  });
  test("on Windows a copy from the last update that cannot be removed (still running) does not stop the update", async () => {
    files = { "/rel/navvied-windows-x64.exe": "new exe", "/rel/SHA256SUMS": `${sha("new exe")}  navvied-windows-x64.exe\n` };
    const exe = join(tmp(), "navvied.exe");
    writeFileSync(exe, "old exe");
    // A folder stands for a file the system will not let go of: removing it as a file fails.
    mkdirSync(`${exe}.old`);
    writeFileSync(join(`${exe}.old`, "held"), "running");
    expect(await updateProgram({ ...target(exe), os: "windows" })).toBe("updated");
    expect(readFileSync(exe, "utf8")).toBe("new exe");
    const aside = readdirSync(join(exe, "..")).filter((n) => n.startsWith("navvied.exe.old."));
    expect(aside).toHaveLength(1);
    expect(readFileSync(join(exe, "..", aside[0]!), "utf8")).toBe("old exe");
  });
  test("updates can be turned off from outside, for a program that is updated by whatever installed it", async () => {
    const f = fakeIO({ env: { NAVVIED_NO_UPDATE: "1" } });
    expect(await main(["update"], f.io)).toBe(2);
    expect(f.err()).toContain("Updates are turned off here");
  });
  test("only an installed program can update itself, not a source checkout", async () => {
    expect(isInstalledProgram("/usr/local/bin/navvied")).toBe(true);
    expect(isInstalledProgram("/home/u/.bun/bin/bun")).toBe(false);
    const f = fakeIO({ env: {} });
    expect(await main(["update"], f.io)).toBe(2);
    expect(f.err()).toContain("running from source");
  });
});

describe("navvied doctor", () => {
  const withConfig = (models: Record<string, unknown>, extra: Record<string, string> = {}) => {
    const state = tmp(), config = join(state, "config.json");
    mkdirSync(state, { recursive: true });
    writeFileSync(config, JSON.stringify({ models }));
    return { config, env: { HOME: state, XDG_STATE_HOME: state, PATH: process.env.PATH ?? "", ...extra } };
  };

  test("a reachable model server and a working machine: all good, exit 0", async () => {
    const { config, env } = withConfig({ a: { baseUrl: "http://127.0.0.1:11434", api: "ollama", model: "m" } });
    const f = fakeIO({ env, fetch: localFetch({ 11434: ["m"] }) });
    expect(await main(["doctor", "--config", config], f.io)).toBe(0);
    expect(f.err()).toMatch(/✓ config\s+.*\(1 model\)/);
    expect(f.err()).toMatch(/✓ model\s+a: http:\/\/127.0.0.1:11434 answered/);
    expect(f.err()).toMatch(/✓ git/);
    expect(f.err()).toContain("All good.");
  });
  test("an Ollama entry on the old /v1 address is flagged: it keeps only 4096 tokens", async () => {
    const { config, env } = withConfig({ a: { baseUrl: "http://127.0.0.1:11434/v1", model: "m" } });
    const f = fakeIO({ env, fetch: localFetch({ 11434: ["m"] }) });
    expect(await main(["doctor", "--config", config], f.io)).toBe(1);
    expect(f.err()).toMatch(/✗ memory\s+Ollama keeps only 4096 tokens/);
  });
  test("an unreachable server is a problem, exit 1", async () => {
    const { config, env } = withConfig({ a: { baseUrl: "http://127.0.0.1:9/v1", model: "m" } });
    const f = fakeIO({ env, fetch: localFetch({}) });
    expect(await main(["doctor", "--config", config], f.io)).toBe(1);
    expect(f.err()).toMatch(/✗ model\s+a: .* did not answer/);
    expect(f.err()).toContain("1 problem found.");
  });
  test("an agent program is checked on the PATH", async () => {
    const ok = withConfig({ s: { command: "bun" } });
    const a = fakeIO({ env: ok.env });
    expect(await main(["doctor", "--config", ok.config], a.io)).toBe(0);
    const missing = withConfig({ s: { command: "no-such-program-xyz" } });
    const b = fakeIO({ env: missing.env });
    expect(await main(["doctor", "--config", missing.config], b.io)).toBe(1);
    expect(b.err()).toContain('"no-such-program-xyz" is not on your PATH');
  });
  test("nothing configured says how to fix it; a broken file is reported", async () => {
    const f = fakeIO({ env: { HOME: tmp(), PATH: process.env.PATH ?? "" } });
    expect(await main(["doctor"], f.io)).toBe(1);
    expect(f.err()).toMatch(/○ config\s+no model connected yet; run navvied init/);
    expect(f.err()).toMatch(/✗ model\s+no model is connected yet/);
    const state = tmp(), config = join(state, "bad.json");
    writeFileSync(config, "{oops");
    const g = fakeIO({ env: { HOME: state } });
    expect(await main(["doctor", "--config", config], g.io)).toBe(1);
    expect(g.err()).toMatch(/✗ config/);
  });
});

describe("which build a machine needs", () => {
  const avx2 = "flags : fpu sse4_2 avx avx2 bmi2";
  test.each([
    ["darwin", "arm64", undefined, undefined, "navvied-darwin-arm64"],
    ["darwin", "x64", undefined, undefined, "navvied-darwin-x64"],
    ["win32", "x64", undefined, undefined, "navvied-windows-x64.exe"],
    ["win32", "arm64", undefined, undefined, "navvied-windows-arm64.exe"],
    ["linux", "x64", avx2, [], "navvied-linux-x64"],
    ["linux", "x64", "flags : fpu sse4_2", [], "navvied-linux-x64-baseline"],
    ["linux", "x64", "", [], "navvied-linux-x64"],
    ["linux", "arm64", "flags : fp asimd", [], "navvied-linux-arm64"],
    ["linux", "x64", avx2, ["ld-musl-x86_64.so.1"], "navvied-linux-x64-musl"],
    ["linux", "arm64", undefined, ["ld-musl-aarch64.so.1"], "navvied-linux-arm64-musl"],
  ] as const)("%s %s → %s", (platform, arch, cpu, libs, asset) => {
    expect(assetName(detectMachine(platform, arch, cpu, libs ? [...libs] : undefined))).toBe(asset);
  });
});

describe("automatic updates", () => {
  const sha = (b: string) => new Bun.CryptoHasher("sha256").update(b).digest("hex");
  const machine = { os: "linux", arch: "x64", variant: "" } as const;
  const release = (body: string): typeof fetch => (async (u: string | URL | Request) => String(u).endsWith("SHA256SUMS") ? new Response(`${sha(body)}  navvied-linux-x64\n`) : new Response(body)) as unknown as typeof fetch;
  const setupExe = (content: string) => { const d = tmp(); const exe = join(d, "navvied"); writeFileSync(exe, content); return { exe, stamp: join(d, "state", "update-check") }; };

  const T = 400 * 24 * 3600_000;
  test("installs a newer release once, then waits a few minutes before checking again", async () => {
    const { exe, stamp } = setupExe("old");
    const first = await autoUpdate({ env: {}, fetch: release("new"), exe, stamp, machine, now: () => T });
    expect(first).toBe("updated");
    expect(readFileSync(exe, "utf8")).toBe("new");
    expect(await autoUpdate({ env: {}, fetch: release("newer"), exe, stamp, machine, now: () => T + 1_000 })).toBe("skipped");
    expect(readFileSync(exe, "utf8")).toBe("new");
    expect(await autoUpdate({ env: {}, fetch: release("newer"), exe, stamp, machine, now: () => T + 6 * 60_000 })).toBe("updated");
  });

  test("an up-to-date program, a program run from source, an opt-out and a network failure change nothing", async () => {
    const same = setupExe("same");
    expect(await autoUpdate({ env: {}, fetch: release("same"), exe: same.exe, stamp: same.stamp, machine })).toBe("current");
    const dev = setupExe("x");
    expect(await autoUpdate({ env: {}, fetch: release("y"), exe: "/usr/local/bin/bun", stamp: dev.stamp, machine })).toBe("skipped");
    expect(await autoUpdate({ env: { NAVVIED_NO_UPDATE: "1" }, fetch: release("y"), exe: dev.exe, stamp: dev.stamp, machine })).toBe("skipped");
    expect(await autoUpdate({ env: {}, enabled: false, fetch: release("y"), exe: dev.exe, stamp: dev.stamp, machine })).toBe("skipped");
    const down = setupExe("x");
    expect(await autoUpdate({ env: {}, fetch: (async () => { throw new Error("offline"); }) as unknown as typeof fetch, exe: down.exe, stamp: down.stamp, machine })).toBe("skipped");
    expect(readFileSync(down.exe, "utf8")).toBe("x");
  });
});

describe("updating the program, in plain sight", () => {
  const sha = (b: string) => new Bun.CryptoHasher("sha256").update(b).digest("hex");
  const machine = { os: "linux", arch: "x64", variant: "" } as const;
  const program = (v: string) => `#!/bin/sh\necho "navvied ${v}"\n`;
  const streaming = (body: string): typeof fetch => (async (u: string | URL | Request) => {
    if (String(u).endsWith("SHA256SUMS")) return new Response(`${sha(body)}  navvied-linux-x64\n`);
    const bytes = new TextEncoder().encode(body), mid = Math.floor(bytes.length / 2);
    const stream = new ReadableStream({ start(c) { c.enqueue(bytes.slice(0, mid)); c.enqueue(bytes.slice(mid)); c.close(); } });
    return new Response(stream, { headers: { "content-length": String(bytes.length) } });
  }) as unknown as typeof fetch;
  const installed = (content: string): string => { const d = tmp(); const exe = join(d, "navvied"); writeFileSync(exe, content); chmodSync(exe, 0o755); return exe; };

  test("the progress line shows a bar, the percentage, the amount and the speed, and fits the terminal", () => {
    const plain = (t: string): string => t;
    const half = progressLine(5_242_880, 10_485_760, 2, 100, plain);
    expect(half).toMatch(/^ {2}█{20}░{20} {2} 50% {3}5\.0 MB of 10 MB {3}2\.5 MB\/s$/);
    expect(progressLine(0, 10_485_760, 0, 100, plain)).toContain("  0%");
    expect(progressLine(1_048_576, 0, 0, 100, plain)).toBe("  1.0 MB downloaded");
    expect(progressLine(1_048_576, 0, 2, 100, plain)).toBe("  1.0 MB downloaded   0.5 MB/s");
    expect(progressLine(10, 10, 1, 30, plain).length).toBeLessThanOrEqual(30 + 22);
    expect([...progressLine(10, 10, 1, 200, plain)].filter((c) => c === "█").length).toBe(40);
  });

  test("updateProgram reports each step in order, with the download counted up to the full size", async () => {
    const exe = installed(program("1.0.0"));
    const seen: UpdateProgress[] = [];
    await updateProgram({ ...machine, base: "http://release.test", exe, fetch: streaming(program("2.0.0")) }, (p) => seen.push(p));
    expect(seen.map((p) => p.step)).toEqual(["checking", "downloading", "downloading", "verifying", "installing"]);
    const last = seen.filter((p) => p.step === "downloading").at(-1) as Extract<UpdateProgress, { step: "downloading" }>;
    expect(last.received).toBe(last.total);
  });

  test("on a terminal it says what it is doing, draws the bar, and ends with the old and the new version", async () => {
    if (process.platform === "win32") return;
    const exe = installed(program("1.0.0"));
    const f = fakeIO({ interactive: true, fetch: streaming(program("9.9.9")) });
    expect(await updateCommand(undefined, f.io, exe, machine)).toBe(0);
    const out = f.err();
    expect(out).toContain("Checking for a newer version");
    expect(out).toContain("A newer version is available. Downloading");
    expect(out).toMatch(/█+░*/);
    expect(out).toContain("Checking that the file is genuine");
    expect(out).toMatch(/Updated from \S+ to 9\.9\.9\. It starts the next time you run navvied\./);
  });

  test("without a terminal it prints the steps but no moving bar", async () => {
    if (process.platform === "win32") return;
    const exe = installed(program("1.0.0"));
    const f = fakeIO({ fetch: streaming(program("9.9.9")) });
    expect(await updateCommand(undefined, f.io, exe, machine)).toBe(0);
    expect(f.err()).not.toContain("\r");
    expect(f.err()).not.toContain("█");
    expect(f.err()).toContain("Updated from");
  });

  test("when nothing is newer it says so with the version it has, and a failure is reported plainly", async () => {
    const exe = installed(program("5.0.0"));
    const same = fakeIO({ fetch: streaming(program("5.0.0")) });
    expect(await updateCommand(undefined, same.io, exe, machine)).toBe(0);
    expect(same.err()).toMatch(/You already have the latest version \(\S+\)\./);
    const bad = fakeIO({ fetch: (async () => new Response("no", { status: 500 })) as unknown as typeof fetch });
    expect(await updateCommand(undefined, bad.io, exe, machine)).toBe(1);
    expect(bad.err()).toMatch(/error: could not download .*SHA256SUMS \(500\)/);
  });

  test("a program run from source is not touched, and it says why", async () => {
    const f = fakeIO();
    expect(await updateCommand(undefined, f.io, "/usr/local/bin/bun", machine)).toBe(2);
    expect(f.err()).toContain("update works on the installed program");
  });
});
