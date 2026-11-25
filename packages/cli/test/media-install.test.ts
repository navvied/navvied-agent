import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import type { EngineEvent } from "@navvied/protocol";
import { configPath, loadConfig } from "../src/config.ts";
import type { Probe } from "../src/machine.ts";
import { mediaSetups } from "../src/media-hub.ts";
import { fetchPieces, isFetched, setupFor, systemKey, toolFolder, type FetchState } from "../src/media-install.ts";
import { IMAGE_SETTINGS, MEDIA_SETUPS, VISION_FILES, type Piece, type Setup } from "../src/media-pins.ts";
import { tar } from "./archives.ts";
import { fakeIO, fakeSystem, remove, tempDir, until } from "./helpers.ts";

const dirs: string[] = [];
const scratch = (): string => { const d = tempDir(); dirs.push(d); return d; };
const servers: { stop(force?: boolean): void }[] = [];
afterAll(() => { servers.forEach((s) => { s.stop(true); }); dirs.forEach(remove); });

const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
const posix = process.platform !== "win32";

/** A release server on this computer: a path gives bytes, a request that asks past some bytes is answered with the rest, and the first answer for a path can be cut short. */
function releases(files: Record<string, Buffer>, o: { cut?: Record<string, number> } = {}) {
  const asked: { path: string; range: string | null }[] = [];
  const cut = { ...o.cut };
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      const body = files[path];
      const range = req.headers.get("range");
      asked.push({ path, range });
      if (!body) return new Response("no", { status: 404 });
      const from = range ? Number(/bytes=(\d+)-/.exec(range)![1]) : 0;
      const part = body.subarray(from);
      const stop = cut[path];
      if (stop !== undefined) {
        delete cut[path];
        return new Response(new ReadableStream({ start(c) { c.enqueue(part.subarray(0, stop)); setTimeout(() => { c.close(); }, 20); } }), { status: 200, headers: { "content-length": String(part.length) } });
      }
      return new Response(part, { status: range ? 206 : 200, headers: { "content-length": String(part.length), ...(range ? { "content-range": `bytes ${from}-${body.length - 1}/${body.length}` } : {}) } });
    },
  });
  servers.push(server);
  return { base: `http://127.0.0.1:${server.port}`, asked };
}

const piece = (base: string, file: string, body: Buffer, unpack?: Piece["unpack"]): Piece => ({ file, url: `${base}/${file}`, sha256: sha(body), size: body.length, ...(unpack ? { unpack } : {}) });
const run = (dir: string, pieces: Piece[], more: Partial<Parameters<typeof fetchPieces>[0]> = {}) => {
  const states: FetchState[] = [];
  const result = fetchPieces({ pieces, dir, fetchFn: fetch, freeBytes: () => undefined, onState: (s) => states.push(s), ...more });
  return { result, states };
};

const program = Buffer.from("#!/bin/sh\necho ok\n");
const whisperTar = gzipSync(tar([{ name: "w/", type: "5", mode: 0o755 }, { name: "w/whisper-cli", body: program, mode: 0o755 }]));
const model = Buffer.from("model bytes ".repeat(5000));

describe("fetching what a tool needs", () => {
  test("every file is proven, the archive is taken apart owner-only, what is done is written down, and the program is tried once", async () => {
    const files = { "/a.tar.gz": whisperTar, "/m.bin": model };
    const { base } = releases(files);
    const dir = scratch();
    const pieces = [piece(base, "a.tar.gz", whisperTar, "tar.gz"), piece(base, "m.bin", model)];
    const tried: (readonly string[])[] = [];
    const { result, states } = run(dir, pieces, { check: { program: join(dir, "a", "w", "whisper-cli"), args: ["--help"] }, tryProgram: async (argv) => { tried.push(argv); return true; } });
    expect(await result).toEqual({ ok: true });
    expect(readFileSync(join(dir, "m.bin"))).toEqual(model);
    expect(readFileSync(join(dir, "a", "w", "whisper-cli"))).toEqual(program);
    expect(existsSync(join(dir, "downloads", "a.tar.gz"))).toBe(false);
    expect(isFetched(dir, pieces)).toBe(true);
    expect(tried).toEqual([[join(dir, "a", "w", "whisper-cli"), "--help"]]);
    expect(states.map((s) => s.state)).toEqual(expect.arrayContaining(["downloading", "installing", "verifying", "done"]));
    const last = states.filter((s) => s.state === "downloading").at(-1) as { bytes: number; total: number };
    expect(last.bytes).toBe(last.total);
    if (posix) {
      expect(lstatSync(dir).mode & 0o777).toBe(0o700);
      expect(lstatSync(join(dir, "m.bin")).mode & 0o777).toBe(0o600);
      expect(lstatSync(join(dir, "a", "w", "whisper-cli")).mode & 0o777).toBe(0o700);
      expect(lstatSync(join(dir, "installed.json")).mode & 0o777).toBe(0o600);
    }
  });

  test("a file that is not the one that was published is deleted, nothing is unpacked or run, and the words say so", async () => {
    const { base } = releases({ "/a.tar.gz": whisperTar });
    const dir = scratch();
    const wrong = { ...piece(base, "a.tar.gz", whisperTar, "tar.gz"), sha256: "0".repeat(64) };
    let tried = 0;
    const { result, states } = run(dir, [wrong], { check: { program: join(dir, "x"), args: [] }, tryProgram: async () => { tried++; return true; } });
    expect(await result).toMatchObject({ ok: false, error: expect.stringContaining("not the file that was published") });
    expect(states.at(-1)).toMatchObject({ state: "failed" });
    expect(tried).toBe(0);
    expect(existsSync(join(dir, "downloads", "a.tar.gz"))).toBe(false);
    expect(existsSync(join(dir, "downloads", "a.tar.gz.part"))).toBe(false);
    expect(existsSync(join(dir, "a"))).toBe(false);
    expect(isFetched(dir, [wrong])).toBe(false);
  });

  test("a lost connection leaves the bytes that came, and the next start asks past them", async () => {
    const { base, asked } = releases({ "/m.bin": model }, { cut: { "/m.bin": 1000 } });
    const dir = scratch();
    const p = piece(base, "m.bin", model);
    expect(await run(dir, [p]).result).toMatchObject({ ok: false });
    expect(lstatSync(join(dir, "m.bin.part")).size).toBe(1000);
    expect(await run(dir, [p]).result).toEqual({ ok: true });
    expect(asked.map((a) => a.range)).toEqual([null, "bytes=1000-"]);
    expect(readFileSync(join(dir, "m.bin"))).toEqual(model);
  });

  test("what is already in place is not fetched again, and progress counts only what is left", async () => {
    const { base, asked } = releases({ "/m.bin": model, "/n.bin": Buffer.from("n") });
    const dir = scratch();
    const m = piece(base, "m.bin", model), n = piece(base, "n.bin", Buffer.from("n"));
    await run(dir, [m]).result;
    asked.length = 0;
    const { result, states } = run(dir, [m, n]);
    expect(await result).toEqual({ ok: true });
    expect(asked.map((a) => a.path)).toEqual(["/n.bin"]);
    expect((states.find((s) => s.state === "downloading") as { total: number }).total).toBe(1);
  });

  test("a hostile archive is refused with the reason, and what it made is taken away", async () => {
    const evil = gzipSync(tar([{ name: "../escape", body: "x" }]));
    const { base } = releases({ "/e.tar.gz": evil });
    const dir = scratch();
    const { result } = run(dir, [piece(base, "e.tar.gz", evil, "tar.gz")]);
    expect(await result).toMatchObject({ ok: false, error: expect.stringMatching(/was refused: .*leaves its folder/) });
    expect(existsSync(join(dir, "e"))).toBe(false);
    expect(existsSync(join(dir, "e.unpacking"))).toBe(false);
    expect(existsSync(join(dir, "..", "escape"))).toBe(false);
  });

  test("not enough room on the disk is said before a byte is fetched; a server without the file says what it said", async () => {
    const { base, asked } = releases({});
    const dir = scratch();
    const p = piece(base, "m.bin", model);
    expect(await run(dir, [p], { freeBytes: () => 10 }).result).toMatchObject({ ok: false, error: expect.stringContaining("not enough room") });
    expect(asked).toEqual([]);
    expect(await run(dir, [p]).result).toMatchObject({ ok: false, error: "The server answered 404." });
  });

  test("a program that does not start is not called ready", async () => {
    const { base } = releases({ "/m.bin": model });
    const dir = scratch();
    const { result } = run(dir, [piece(base, "m.bin", model)], { check: { program: join(dir, "m.bin"), args: [] }, tryProgram: async () => false });
    expect(await result).toMatchObject({ ok: false, error: "The program did not start on this computer." });
  });
});

describe("the pinned table", () => {
  test("every file has an address of its release, a size and a SHA-256, and a kind of computer without a pin is told so", () => {
    const all: Piece[] = [...VISION_FILES, ...Object.values(MEDIA_SETUPS).flatMap((s) => s["linux-x64"].pieces as readonly Piece[])];
    expect(all.length).toBe(9);
    for (const p of all) {
      expect(p.sha256, p.file).toMatch(/^[0-9a-f]{64}$/);
      expect(p.size, p.file).toBeGreaterThan(1000);
      expect(p.url, p.file).toMatch(/^https:\/\/(github\.com\/[^/]+\/[^/]+\/releases\/download\/[^/]+\/[^/]+|huggingface\.co\/[^/]+\/[^/]+\/resolve\/[0-9a-f]{40}\/.+)$/);
      expect(p.url.endsWith(`/${p.file}`), p.file).toBe(true);
    }
    expect(new Set(all.map((p) => p.sha256)).size).toBe(all.length);
    expect(systemKey("linux", "x64")).toBe("linux-x64");
    for (const [os, arch] of [["darwin", "arm64"], ["win32", "x64"], ["linux", "arm64"]] as const) expect(setupFor("image", os, arch)).toBeUndefined();
    expect(setupFor("image", "linux", "x64")!.program).toContain("sd-cli");
    expect(IMAGE_SETTINGS).toEqual({ steps: 1, cfg: 1 });
  });
});

describe("the setup of a tool through the program", () => {
  function computer(over: { system?: ReturnType<typeof fakeSystem>; cloud?: boolean; wrong?: boolean; tryProgram?: boolean } = {}) {
    const state = scratch();
    const env = { HOME: state, XDG_STATE_HOME: state, XDG_CONFIG_HOME: state };
    const { base, asked } = releases({ "/a.tar.gz": whisperTar, "/ggml-tiny.en.bin": model });
    const setup: Setup = { pieces: [piece(base, "a.tar.gz", whisperTar, "tar.gz"), { ...piece(base, "ggml-tiny.en.bin", model), ...(over.wrong ? { sha256: "1".repeat(64) } : {}) }], program: "a/w/whisper-cli", check: ["--help"] };
    const io = fakeIO({ env, ...(over.system ? { system: over.system } : {}) });
    const told: EngineEvent[] = [];
    let changed = 0;
    const setups = mediaSetups({
      io: io.io, inCloud: () => over.cloud ?? false, configFile: () => configPath(env), tell: (e) => { told.push(e); }, changed: () => { changed++; },
      probe: () => ({ disk: () => ({ freeMb: 1_000_000, totalMb: 1_000_000 }) }) as unknown as Probe,
      setups: { "speech-to-text": setup }, tryProgram: async () => over.tryProgram ?? true,
    });
    const events = (id: string) => told.filter((e): e is Extract<EngineEvent, { ev: "tool.setup" }> => e.ev === "tool.setup" && e.id === id);
    return { env, asked, setups, told, events, changed: () => changed, config: () => { const f = loadConfig(configPath(env)); return f.ok ? f.value?.media : undefined; } };
  }

  test("it asks first, with every file and the size, and fetches nothing until the answer; then it tells the progress and writes the configuration the tool reads", async () => {
    const c = computer();
    c.setups.start("speech-to-text");
    await until(() => c.events("speech-to-text").some((e) => e.state === "ask"));
    const ask = c.events("speech-to-text").find((e) => e.state === "ask")!;
    expect(ask.files!.map((f) => f.name)).toEqual(["a.tar.gz", "ggml-tiny.en.bin"]);
    expect(ask.totalMb).toBe(1);
    expect(ask.percent).toBe(0);
    expect(ask.steps!.map((s) => [s.name, s.state, s.bytes])).toEqual([["a.tar.gz", "waiting", 0], ["ggml-tiny.en.bin", "waiting", 0]]);
    expect(c.asked).toEqual([]);
    c.setups.approve("speech-to-text");
    await until(() => c.events("speech-to-text").some((e) => e.state === "done"));
    expect(c.events("speech-to-text").map((e) => e.state)).toEqual(expect.arrayContaining(["ask", "downloading", "installing", "verifying", "done"]));
    const during = c.events("speech-to-text").filter((e) => e.state === "downloading");
    for (const e of during) {
      expect(e.percent).toBe(Math.floor((100 * e.bytes!) / e.total!));
      expect(e.steps!.filter((s) => s.state === "active")).toHaveLength(1);
      expect(e.steps!.reduce((n, s) => n + s.total, 0)).toBe(e.total!);
    }
    const finished = c.events("speech-to-text").at(-1)!;
    expect(finished).toMatchObject({ state: "done", percent: 100 });
    expect(finished.steps!.every((s) => s.state === "done" && s.bytes === s.total)).toBe(true);
    const folder = toolFolder(join(c.env.XDG_STATE_HOME, "navvied", "local"), "speech-to-text");
    expect(c.config()).toEqual({ stt: { bin: join(folder, "a", "w", "whisper-cli"), model: join(folder, "ggml-tiny.en.bin"), language: "en" } });
    expect(c.changed()).toBe(1);
    if (posix) expect(lstatSync(configPath(c.env)).mode & 0o777).toBe(0o600);
  });

  test("bypass does not ask; any other mode does", async () => {
    const c = computer();
    c.setups.start("speech-to-text", "bypass");
    await until(() => c.events("speech-to-text").some((e) => e.state === "done"));
    expect(c.events("speech-to-text").some((e) => e.state === "ask")).toBe(false);
    for (const mode of ["ask", "edits", "plan", "auto"] as const) {
      const d = computer();
      d.setups.start("speech-to-text", mode);
      await until(() => d.events("speech-to-text").some((e) => e.state === "ask"));
      expect(d.asked).toEqual([]);
      d.setups.cancel("speech-to-text");
      await until(() => d.events("speech-to-text").some((e) => e.state === "idle"));
      expect(d.events("speech-to-text").at(-1)!.steps!.every((s) => s.state === "waiting")).toBe(true);
    }
  });

  test("a setup that is declined fetches nothing and writes nothing", async () => {
    const c = computer();
    c.setups.start("speech-to-text");
    await until(() => c.events("speech-to-text").some((e) => e.state === "ask"));
    c.setups.cancel("speech-to-text");
    await until(() => c.events("speech-to-text").some((e) => e.state === "idle"));
    expect(c.asked).toEqual([]);
    expect(c.config()).toBeUndefined();
    expect(c.changed()).toBe(0);
  });

  test("a file with the wrong hash fails the setup in words and leaves the configuration alone", async () => {
    const c = computer({ wrong: true });
    c.setups.start("speech-to-text", "bypass");
    await until(() => c.events("speech-to-text").some((e) => e.state === "failed"));
    expect(c.events("speech-to-text").at(-1)!.error).toContain("not the file that was published");
    const failed = c.events("speech-to-text").at(-1)!.steps!;
    expect(failed.filter((s) => s.state === "failed")).toHaveLength(1);
    expect(failed.some((s) => s.state === "active")).toBe(false);
    expect(c.config()).toBeUndefined();
    expect(c.changed()).toBe(0);
  });

  test("a program that does not start fails it; done twice does not fetch twice and does not ask", async () => {
    const bad = computer({ tryProgram: false });
    bad.setups.start("speech-to-text", "bypass");
    await until(() => bad.events("speech-to-text").some((e) => e.state === "failed"));
    expect(bad.config()).toBeUndefined();

    const c = computer();
    c.setups.start("speech-to-text", "bypass");
    await until(() => c.events("speech-to-text").some((e) => e.state === "done"));
    const hits = c.asked.length;
    c.setups.start("speech-to-text");
    await until(() => c.events("speech-to-text").filter((e) => e.state === "done").length === 2);
    expect(c.asked.length).toBe(hits);
    expect(c.events("speech-to-text").filter((e) => e.state === "ask")).toHaveLength(0);
  });

  test("video generation, a cloud session and video analysis without ffmpeg say plainly that it cannot be done here", async () => {
    const c = computer({ system: fakeSystem() });
    c.setups.start("video-generation");
    c.setups.start("video-analysis");
    expect(c.events("video-generation")).toEqual([{ ev: "tool.setup", id: "video-generation", state: "unavailable", error: "Video cannot be made on this computer. It needs a service." }]);
    expect(c.events("video-analysis")).toEqual([{ ev: "tool.setup", id: "video-analysis", state: "unavailable", error: "Video analysis needs ffmpeg. Install it first." }]);
    const cloud = computer({ cloud: true });
    cloud.setups.start("speech-to-text");
    expect(cloud.events("speech-to-text")[0]).toMatchObject({ state: "unavailable" });
    expect(cloud.asked).toEqual([]);
    c.setups.start("nonsense");
    expect(c.told.at(-1)).toEqual({ ev: "error", msg: "That tool has nothing to set up." });
  });
});
