import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { writeAccount } from "../src/account.ts";
import { createHub } from "../src/commands/hub.ts";
import { accountPath, configPath, loadConfig, resolveModel } from "../src/config.ts";
import { visionFor } from "../src/create.ts";
import { parseMedia } from "../src/media-config.ts";
import { mediaFor, mediaServer } from "../src/media-setup.ts";
import { HOOK_MS, hook, removeTree } from "../../protocol/test/support/cleanup.ts";
import { fakeIO, startMockModel, until } from "./helpers.ts";

const dir = mkdtempSync(join(tmpdir(), "navvied-media-cfg-"));
afterAll(hook("media setup removes what it made", async () => { await removeTree(dir); }), HOOK_MS);
const win = process.platform === "win32";
const write = (name: string, body: unknown): string => { const p = join(dir, name); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, typeof body === "string" ? body : JSON.stringify(body)); return p; };

describe("the media part of config.json", () => {
  test("engines are a program and the files it needs; nothing else is read into them", () => {
    const m = parseMedia({
      stt: { bin: "/w/whisper-cli", model: "/w/ggml.bin", language: "en", extra: "dropped" },
      tts: { engine: "kokoro", bin: "/k/kokoro", model: "/k/m.onnx", voices: "/k/v.bin", voice: "af_sarah" },
      image: { bin: "/s/sd", model: "/s/m.safetensors" },
      vision: { model: "eyes" }, ffmpeg: "/usr/bin/ffmpeg", pdftoppm: "/usr/bin/pdftoppm",
    });
    expect(m).toEqual({
      stt: { bin: "/w/whisper-cli", model: "/w/ggml.bin", language: "en" },
      tts: { engine: "kokoro", bin: "/k/kokoro", model: "/k/m.onnx", voices: "/k/v.bin", voice: "af_sarah" },
      image: { bin: "/s/sd", model: "/s/m.safetensors" },
      vision: { model: "eyes" }, ffmpeg: "/usr/bin/ffmpeg", pdftoppm: "/usr/bin/pdftoppm",
    });
  });

  test("a wrong key is refused in words, with the file's name when it is loaded", () => {
    expect(parseMedia("x")).toContain("must be an object");
    expect(parseMedia({ stt: { bin: "/w" } })).toContain('"media.stt" needs a program in "bin" and a file in "model"');
    expect(parseMedia({ tts: { bin: "/p", model: "/m", engine: "festival" } })).toContain('"piper" or "kokoro"');
    expect(parseMedia({ tts: { bin: "/p", model: "/m", engine: "kokoro" } })).toContain("voices");
    expect(parseMedia({ vision: {} })).toContain('"media.vision"');
    expect(parseMedia({ ffmpeg: 3 })).toContain('"media.ffmpeg" must be a path');
    const r = loadConfig(write("bad-media.json", { models: {}, media: { image: 4 } }), {});
    expect(!r.ok && r.error).toContain("bad-media.json");
    const good = loadConfig(write("good-media.json", { models: {}, media: { image: { bin: "/s", model: "/m" } } }), {});
    expect(good.ok && good.value?.media).toEqual({ image: { bin: "/s", model: "/m" } });
  });
});

describe("where the media routes are", () => {
  const home = (name: string): Record<string, string> => ({ HOME: join(dir, name), XDG_STATE_HOME: join(dir, name), XDG_CONFIG_HOME: join(dir, name) });

  test("a hosted session uses its own service, a signed-in computer its account, and a guest or a sandbox none", () => {
    const env = home("acct");
    expect(mediaServer(env, {})()).toBeUndefined();
    writeAccount(accountPath(env, undefined), { server: "https://example.test/", token: "acct-token", email: "a@b.c" });
    expect(mediaServer(env, {})()).toEqual({ url: "https://example.test/api/media", token: "acct-token" });
    expect(mediaServer(env, { sandboxed: true })()).toBeUndefined();
    expect(mediaServer(env, { webProxy: { url: "http://10.0.0.1:4000/v1/web", token: "grant" } })()).toEqual({ url: "http://10.0.0.1:4000/v1/media", token: "grant" });
  });
});

describe("the model that looks at pictures", () => {
  const entry = (extra: object) => ({ baseUrl: "http://127.0.0.1:1/v1", model: "m", ...extra });
  const file = write("vision.json", { models: { eyes: entry({ vision: true }), blind: entry({ vision: false }), plain: entry({}) }, default: "plain", media: { vision: { model: "eyes" } } });
  const none = write("vision-none.json", { models: { eyes: entry({ vision: true }), blind: entry({ vision: false }) }, default: "blind" });
  const load = (path: string) => { const f = loadConfig(path, {}); if (!f.ok) throw new Error(f.error); return f.value; };
  const now = (path: string, name: string) => { const m = resolveModel(name, load(path), {}, path); if (!m.ok) throw new Error(m.error); return m.value; };

  test("the one the configuration names is used, even when the conversation's own model is blind", () => {
    expect(visionFor(load(file), now(file, "plain"), {}, file)).toBeDefined();
  });
  test("without a named one, the conversation's own model is used when it sees, and nothing is when it does not", () => {
    expect(visionFor(load(none), now(none, "eyes"), {}, none)).toBeDefined();
    expect(visionFor(load(none), now(none, "blind"), {}, none)).toBeUndefined();
  });
  test("a named model that is marked blind is not used", () => {
    const f = write("vision-blind.json", { models: { blind: entry({ vision: false }) }, media: { vision: { model: "blind" } } });
    expect(visionFor(load(f), now(f, "blind"), {}, f)).toBeUndefined();
  });
  test("a configuration with a vision model gives a Media that can look, and watch only with ffmpeg", () => {
    const m = now(file, "plain");
    expect(mediaFor({}, load(file)?.media, {}, visionFor(load(file), m, {}, file)).has("look")).toBe(true);
    expect(mediaFor({}, { ...load(file)!.media!, ffmpeg: "/x/ffmpeg" }, {}, visionFor(load(file), m, {}, file)).has("watch")).toBe(true);
  });
});

describe.skipIf(win)("the tools list on a computer with engines set up", () => {
  test("a row is on when its engine's program and files are there, and waits for setup until then", async () => {
    const mock = startMockModel();
    const home = join(dir, "hubhome"); mkdirSync(home, { recursive: true });
    const env = { HOME: home, XDG_STATE_HOME: home, XDG_CONFIG_HOME: home, NAVVIED_BASE_URL: mock.url, NAVVIED_MODEL: "mock-model", NAVVIED_WINDOW: "100000" };
    const bin = write("hub/whisper-cli", "#!/bin/sh\necho hi\n"); chmodSync(bin, 0o755);
    mkdirSync(dirname(configPath(env, undefined)), { recursive: true });
    writeFileSync(configPath(env, undefined), JSON.stringify({ models: {}, media: { stt: { bin, model: join(dir, "hub", "ggml.bin") } } }));
    const hub = createHub({ json: false, yes: false, thinking: false, cwd: dir } as never, fakeIO({ env }).io, { watch: false });
    const got: { ev: string; [k: string]: unknown }[] = [];
    hub.attach({ send: (line) => { got.push(JSON.parse(String(line))); } }, 0);
    type Entry = { id: string; state: string };
    const state = (id: string) => (got.filter((e) => e.ev === "tools").at(-1) as unknown as { entries: Entry[] } | undefined)?.entries.find((e) => e.id === id)?.state;
    hub.command(JSON.stringify({ cmd: "tools" }), () => undefined);
    await until(() => state("speech-to-text") !== undefined);
    expect(state("speech-to-text")).toBe("needs-setup");
    writeFileSync(join(dir, "hub", "ggml.bin"), "model");
    hub.command(JSON.stringify({ cmd: "tools" }), () => undefined);
    await until(() => state("speech-to-text") === "on" || got.length > 40);
    expect(state("speech-to-text")).toBe("on");
    expect(state("text-to-speech")).toBe("needs-setup");
    await hub.stop();
    mock.stop();
  });
});
