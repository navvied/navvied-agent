import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Machine } from "../src/machine.ts";
import { RUNTIME, RUNTIME_DRIVERS } from "../src/presets.ts";
import { atLeast, backendsFor, installedBinary, installRuntime, pickAsset, runtimeState, tarProgram, type RuntimeAsset, type RuntimePin, type RuntimeState } from "../src/runtime.ts";
import { remove, tempDir } from "./helpers.ts";

const dirs: string[] = [];
const stops: (() => void)[] = [];
afterAll(() => { dirs.forEach(remove); stops.forEach((f) => f()); });
const dir = (): string => { const d = tempDir(); dirs.push(d); return d; };

const machine = (o: Partial<Machine> & { driver?: string; vendor?: "nvidia" | "amd" | "intel" | "apple"; kind?: "discrete" | "integrated" | "unified" } = {}): Machine => ({
  os: o.os ?? "linux", arch: o.arch ?? "x64", ramMb: 16384,
  gpus: o.gpus ?? (o.vendor ? [{ name: "gpu", vendor: o.vendor, kind: o.kind ?? "discrete", ...(o.driver ? { driver: o.driver } : {}) }] : []),
});

describe("the program that unpacks", () => {
  test("on Windows the one the system brings, wherever the system is; elsewhere the tar of the path", () => {
    expect(tarProgram("win32", { SystemRoot: "D:\\Win" })).toBe("D:\\Win\\System32\\tar.exe");
    expect(tarProgram("win32", { windir: "E:\\W" })).toBe("E:\\W\\System32\\tar.exe");
    expect(tarProgram("win32", {})).toBe("C:\\Windows\\System32\\tar.exe");
    expect(tarProgram("linux", { SystemRoot: "x" })).toBe("tar");
    expect(tarProgram("darwin", {})).toBe("tar");
  });
});

describe("which build runs on a computer", () => {
  test("versions are compared part by part, as numbers", () => {
    expect(atLeast("550.54.14", "550.54")).toBe(true);
    expect(atLeast("550.54", "550.54.14")).toBe(false);
    expect(atLeast("610.88", "570.26")).toBe(true);
    expect(atLeast("99", "100")).toBe(false);
    expect(atLeast("x", "1")).toBe(false);
  });

  test("a card of the maker whose toolkit has a build: the newest toolkit its driver allows, then the one every card with a Vulkan driver runs, then the processor", () => {
    expect(backendsFor(machine({ vendor: "nvidia", driver: "630.1" }), RUNTIME_DRIVERS)).toEqual(["cuda13", "cuda12", "vulkan", "cpu"]);
    expect(backendsFor(machine({ vendor: "nvidia", driver: "610.88" }), RUNTIME_DRIVERS)).toEqual(["cuda12", "vulkan", "cpu"]);
    expect(backendsFor(machine({ vendor: "nvidia", driver: "560.0" }), RUNTIME_DRIVERS)).toEqual(["vulkan", "cpu"]);
    expect(backendsFor(machine({ os: "windows", vendor: "nvidia", driver: "552.22" }), RUNTIME_DRIVERS)).toEqual(["cuda12", "vulkan", "cpu"]);
    expect(backendsFor(machine({ os: "windows", vendor: "nvidia", driver: "551.60" }), RUNTIME_DRIVERS)).toEqual(["vulkan", "cpu"]);
    expect(backendsFor(machine({ os: "wsl", vendor: "nvidia", driver: "610.88" }), RUNTIME_DRIVERS)[0]).toBe("cuda12");
  });

  test("no driver read, another maker's card with its own memory, a card that shares the memory, and no card", () => {
    expect(backendsFor(machine({ vendor: "nvidia" }), RUNTIME_DRIVERS)).toEqual(["vulkan", "cpu"]);
    expect(backendsFor(machine({ vendor: "amd" }), RUNTIME_DRIVERS)).toEqual(["vulkan", "cpu"]);
    expect(backendsFor(machine({ vendor: "intel", kind: "integrated" }), RUNTIME_DRIVERS)).toEqual(["cpu"]);
    expect(backendsFor(machine(), RUNTIME_DRIVERS)).toEqual(["cpu"]);
    expect(backendsFor(machine({ arch: "arm64", vendor: "nvidia", driver: "630.1" }), RUNTIME_DRIVERS)).toEqual(["vulkan", "cpu"]);
  });

  test("macOS: the one with Apple's own chip uses its graphics, the other the processor; a system that is not known gets nothing", () => {
    expect(backendsFor(machine({ os: "macos", arch: "arm64" }), RUNTIME_DRIVERS)).toEqual(["metal"]);
    expect(backendsFor(machine({ os: "macos" }), RUNTIME_DRIVERS)).toEqual(["cpu"]);
    expect(backendsFor(machine({ os: "unknown" }), RUNTIME_DRIVERS)).toEqual([]);
  });

  test("a person may name the build, and a build that does not exist for the system is none", () => {
    const m = machine({ vendor: "nvidia", driver: "630.1" });
    expect(pickAsset(RUNTIME, m, RUNTIME_DRIVERS, "cpu")).toMatchObject({ backend: "cpu", os: "linux", arch: "x64" });
    expect(pickAsset(RUNTIME, m, RUNTIME_DRIVERS, "vulkan")?.backend).toBe("vulkan");
    expect(pickAsset(RUNTIME, machine({ os: "macos", arch: "arm64" }), RUNTIME_DRIVERS, "cuda12")).toBeUndefined();
    // Apple silicon has one build, which also runs on the processor alone: asking for the processor gives it (the run then puts no layer on the graphics).
    expect(pickAsset(RUNTIME, machine({ os: "macos", arch: "arm64" }), RUNTIME_DRIVERS, "cpu")).toMatchObject({ os: "macos", arch: "arm64", backend: "metal" });
    expect(pickAsset(RUNTIME, machine({ os: "macos" }), RUNTIME_DRIVERS, "cpu")).toMatchObject({ os: "macos", arch: "x64", backend: "cpu" });
  });

  test("the table of builds has, for every system the program runs on, a build for the processor, and for every backend that can be chosen a build to go with it", () => {
    for (const [os, arch] of [["linux", "x64"], ["linux", "arm64"], ["macos", "arm64"], ["macos", "x64"], ["windows", "x64"], ["windows", "arm64"]] as const) {
      expect(RUNTIME.assets.some((a) => a.os === os && a.arch === arch && (a.backend === "cpu" || a.backend === "metal"))).toBe(true);
    }
    const machines = [machine({ vendor: "nvidia", driver: "630.1" }), machine({ os: "windows", vendor: "nvidia", driver: "630.1" }), machine({ vendor: "amd" }), machine({ os: "windows", arch: "arm64", vendor: "amd" }), machine({ os: "macos", arch: "arm64" })];
    for (const m of machines) expect(pickAsset(RUNTIME, m, RUNTIME_DRIVERS)).toBeDefined();
    expect(pickAsset(RUNTIME, machine({ vendor: "nvidia", driver: "610.88" }), RUNTIME_DRIVERS)).toMatchObject({ backend: "cuda12", os: "linux" });
    expect(pickAsset(RUNTIME, machine({ os: "wsl", vendor: "nvidia", driver: "610.88" }), RUNTIME_DRIVERS)?.os).toBe("linux");
  });

  test("the pinned files each carry a SHA-256 and a size, belong to the release, and a CUDA build comes with its runtime", () => {
    for (const a of RUNTIME.assets) {
      expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(a.size).toBeGreaterThan(1_000_000);
      expect(a.file.includes(RUNTIME.tag) || a.file.startsWith("cudart")).toBe(true);
      if (a.backend.startsWith("cuda")) expect((a as RuntimeAsset).with?.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(RUNTIME.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(new Set(RUNTIME.assets.map((a) => a.sha256)).size).toBe(RUNTIME.assets.length);
  });
});

/** What the installer runs to unpack: the system's own tar on Windows, whose name is a path. */
const TAR = tarProgram(process.platform, process.env);
const NAME = process.platform === "win32" ? "llama-server.exe" : "llama-server";

/** A build as the release makes one: an archive with the program in a folder of its own, and a library beside it. */
async function archive(o: { extra?: (root: string) => void; noServer?: boolean } = {}): Promise<{ file: string; sha256: string; size: number; bytes: Uint8Array }> {
  const d = dir(), root = join(d, "src", "build-x");
  mkdirSync(root, { recursive: true });
  if (!o.noServer) writeFileSync(join(root, NAME), "program");
  writeFileSync(join(root, "libx.so"), "library");
  o.extra?.(root);
  const file = join(d, "a.tar.gz");
  const made = Bun.spawnSync([TAR, "-czf", file, "-C", join(d, "src"), "build-x"]);
  if (made.exitCode !== 0) throw new Error("tar could not make the archive");
  const bytes = new Uint8Array(readFileSync(file));
  return { file: "a.tar.gz", sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length, bytes };
}

function release(body: Uint8Array | undefined) {
  const asked: string[] = [];
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req) { asked.push(new URL(req.url).pathname); return body ? new Response(body) : new Response("", { status: 404 }); } });
  stops.push(() => s.stop(true));
  return { base: `http://127.0.0.1:${s.port}`, asked };
}

function install(a: Awaited<ReturnType<typeof archive>>, served: Uint8Array | undefined, o: { version?: number; free?: number; local?: string; signal?: AbortSignal } = {}) {
  const local = o.local ?? dir();
  const srv = release(served);
  const pin: RuntimePin = { tag: "b1", commit: "c".repeat(40), base: `${srv.base}/rel`, assets: [] };
  const asset: RuntimeAsset = { os: "linux", arch: "x64", backend: "cpu", file: a.file, sha256: a.sha256, size: a.size };
  const states: RuntimeState[] = [];
  const ran: string[][] = [];
  const run = async (argv: string[], _t: number) => {
    ran.push(argv);
    if (argv[0] === TAR) { const r = Bun.spawnSync(argv); return { code: r.exitCode ?? 1, output: "" }; }
    return { code: o.version ?? 0, output: "version: 1" };
  };
  const go = () => installRuntime({ pin, asset, local, fetchFn: fetch, run, freeBytes: () => o.free, platform: process.platform, ...(o.signal ? { signal: o.signal } : {}), onState: (s) => states.push(s) });
  return { go, states, ran, local, pin, asset, srv };
}

describe("fetching a build", () => {
  test("fetched, proven, unpacked, run once for its version, written down, and the archive taken away; the states go in that order", async () => {
    const a = await archive();
    const i = install(a, a.bytes);
    const r = await i.go();
    expect(r.ok).toBe(true);
    const binary = (r as { binary: string }).binary;
    expect(binary.endsWith(NAME)).toBe(true);
    expect(i.ran.map((x) => x[0])).toEqual([TAR, binary]);
    expect(i.ran[1]).toEqual([binary, "--version"]);
    expect(i.states.map((s) => s.state).filter((s, n, all) => all.indexOf(s) === n)).toEqual(["installing", "verifying", "ready"]);
    expect(i.states.at(-1)).toMatchObject({ state: "ready", tag: "b1", backend: "cpu", binary });
    if (process.platform !== "win32") expect(statSync(binary).mode & 0o111).not.toBe(0);
    expect(installedBinary(i.local, i.pin, i.asset)).toBe(binary);
    expect(readdirSync(join(i.local, "runtime", "b1", "downloads"))).toEqual([]);
    expect(i.srv.asked).toEqual([`/rel/b1/${a.file}`]);
  });

  test("a file that is not the one that was published is deleted and nothing is run: not the unpacking tool, not the program", async () => {
    const a = await archive();
    const other = new Uint8Array(a.bytes.length).fill(7);
    const i = install(a, other);
    const r = await i.go();
    expect(r).toEqual({ ok: false, error: `${a.file} is not the file that was published (its hash is different): it was deleted and nothing of it was run.` });
    expect(i.ran).toEqual([]);
    expect(existsSync(join(i.local, "runtime", "b1", "downloads", a.file))).toBe(false);
    expect(existsSync(join(i.local, "runtime", "b1", "downloads", `${a.file}.part`))).toBe(false);
    expect(installedBinary(i.local, i.pin, i.asset)).toBeUndefined();
    expect(i.states.at(-1)).toMatchObject({ state: "failed" });
  });

  test("a program that does not start is deleted again, and so is an archive without it", async () => {
    const a = await archive();
    const i = install(a, a.bytes, { version: 1 });
    expect(await i.go()).toEqual({ ok: false, error: "The program did not start: it was deleted." });
    expect(existsSync(join(i.local, "runtime", "b1", "linux-x64-cpu"))).toBe(false);
    const b = await archive({ noServer: true });
    const j = install(b, b.bytes);
    expect(await j.go()).toEqual({ ok: false, error: "The program was not in what was unpacked." });
    expect(j.ran.map((x) => x[0])).toEqual([TAR]);
  });

  test.skipIf(process.platform === "win32")("an archive that puts a file outside its folder is refused and deleted, and the program is not run", async () => {
    const a = await archive({ extra: (root) => symlinkSync("/etc", join(root, "out")) });
    const i = install(a, a.bytes);
    expect(await i.go()).toEqual({ ok: false, error: "The unpacked files were not all inside the folder they belong in: they were deleted." });
    expect(i.ran.map((x) => x[0])).toEqual([TAR]);
    expect(existsSync(join(i.local, "runtime", "b1", "linux-x64-cpu"))).toBe(false);
  });

  test("not started when the disk has no room, and the release is not asked", async () => {
    const a = await archive();
    const i = install(a, a.bytes, { free: 10 });
    const r = await i.go();
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toMatch(/^There is not enough room on the disk: \d+ MB are needed and 0 MB are free\.$/);
    expect(i.srv.asked).toEqual([]);
  });

  test("a build that is there is ready without a new download; one that was taken apart is not", async () => {
    const a = await archive();
    const i = install(a, a.bytes);
    await i.go();
    const m = machine();
    const pin: RuntimePin = { ...i.pin, assets: [i.asset] };
    expect(runtimeState(i.local, pin, m, RUNTIME_DRIVERS)).toMatchObject({ state: "ready", backend: "cpu" });
    remove(join(i.local, "runtime", "b1", "linux-x64-cpu", "build-x", NAME));
    expect(runtimeState(i.local, pin, m, RUNTIME_DRIVERS)).toMatchObject({ state: "none" });
    expect(runtimeState(i.local, { ...pin, assets: [] }, m, RUNTIME_DRIVERS)).toEqual({ state: "failed", error: "There is no build of the runtime for this computer." });
  });

  test("a build with its CUDA runtime fetches both and unpacks both into the one folder", async () => {
    const a = await archive();
    const b = await archive({ extra: (root) => writeFileSync(join(root, "libcudart.so"), "cuda") });
    const srv = (() => { const asked: string[] = []; const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req) { const p = new URL(req.url).pathname; asked.push(p); return new Response(p.endsWith("a.tar.gz") ? a.bytes : b.bytes); } }); stops.push(() => s.stop(true)); return { base: `http://127.0.0.1:${s.port}`, asked }; })();
    const local = dir();
    const pin: RuntimePin = { tag: "b2", commit: "d".repeat(40), base: srv.base, assets: [] };
    const asset: RuntimeAsset = { os: "linux", arch: "x64", backend: "cuda12", file: "a.tar.gz", sha256: a.sha256, size: a.size, with: { file: "rt.tar.gz", sha256: b.sha256, size: b.size } };
    const run = async (argv: string[]) => (argv[0] === TAR ? { code: Bun.spawnSync(argv).exitCode ?? 1, output: "" } : { code: 0, output: "" });
    const r = await installRuntime({ pin, asset, local, fetchFn: fetch, run, freeBytes: () => undefined, platform: process.platform, onState: () => undefined });
    expect(r.ok).toBe(true);
    expect(srv.asked).toEqual(["/b2/a.tar.gz", "/b2/rt.tar.gz"]);
    expect(existsSync(join(local, "runtime", "b2", "linux-x64-cuda12", "build-x", "libcudart.so"))).toBe(true);
  });

  test("a download that is paused leaves its part, and the next start goes on from it", async () => {
    const a = await archive({ extra: (root) => { const noise = new Uint8Array(400_000); for (let off = 0; off < noise.length; off += 65_536) crypto.getRandomValues(noise.subarray(off, off + 65_536)); writeFileSync(join(root, "big.bin"), noise); } });
    const local = dir();
    const stall = new AbortController();
    const ranges: (string | null)[] = [];
    const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req) {
      ranges.push(req.headers.get("range"));
      const m = /bytes=(\d+)-/.exec(req.headers.get("range") ?? "");
      const from = m ? Number(m[1]) : 0;
      const rest = a.bytes.slice(from);
      return new Response(new ReadableStream({ async start(c) { c.enqueue(rest.slice(0, 20_000)); if (from === 0) await new Promise((r) => setTimeout(r, 1500)); c.enqueue(rest.slice(20_000)); c.close(); } }), { status: m ? 206 : 200, headers: { "content-length": String(rest.length), ...(m ? { "content-range": `bytes ${from}-${a.bytes.length - 1}/${a.bytes.length}` } : {}) } });
    } });
    stops.push(() => s.stop(true));
    const pin: RuntimePin = { tag: "b3", commit: "e".repeat(40), base: `http://127.0.0.1:${s.port}`, assets: [] };
    const asset: RuntimeAsset = { os: "linux", arch: "x64", backend: "cpu", file: a.file, sha256: a.sha256, size: a.size };
    const run = async (argv: string[]) => (argv[0] === TAR ? { code: Bun.spawnSync(argv).exitCode ?? 1, output: "" } : { code: 0, output: "" });
    const part = join(local, "runtime", "b3", "downloads", `${a.file}.part`);
    const watch = setInterval(() => { try { if (statSync(part).size > 0) stall.abort("pause"); } catch { /* not there yet */ } }, 5);
    const first = await installRuntime({ pin, asset, local, fetchFn: fetch, run, freeBytes: () => undefined, platform: process.platform, signal: stall.signal, onState: () => undefined });
    clearInterval(watch);
    expect(first).toEqual({ ok: false, error: "paused" });
    expect(statSync(part).size).toBeGreaterThan(0);
    const again = await installRuntime({ pin, asset, local, fetchFn: fetch, run, freeBytes: () => undefined, platform: process.platform, onState: () => undefined });
    expect(again.ok).toBe(true);
    expect(ranges[0]).toBeNull();
    expect(ranges[1]).toMatch(/^bytes=\d+-$/);
  });
});
