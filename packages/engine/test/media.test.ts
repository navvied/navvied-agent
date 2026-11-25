import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Media, MediaError } from "../src/index.ts";
import { PNG, cleanScratch, fakeService, program, remote, scratch } from "./media-support.ts";

afterAll(cleanScratch);
const win = process.platform === "win32";
const signal = new AbortController().signal;

describe("the media client against the documented routes", () => {
  test("it lists the kinds with the account token, once for the conversation, and offers only free ones", async () => {
    const svc = fakeService([{ kind: "tts", provider: "free" }, { kind: "stt", provider: "free" }, { kind: "video", provider: "paid" }]);
    const media = remote(svc.url);
    await Promise.all([media.refresh(), media.refresh()]);
    await media.refresh();
    expect(svc.seen.filter((s) => s.method === "GET")).toHaveLength(1);
    expect(svc.seen[0]!.auth).toBe("Bearer tok");
    expect([...media.needs()].sort()).toEqual(["stt", "tts"]);
    expect(media.pick("video")).toBeUndefined();
    expect(media.withheld()).toEqual(["video"]);
    svc.stop();
  });

  test("a kind the service does not list is not there, and neither is a service that cannot be asked", async () => {
    const svc = fakeService([]);
    const media = remote(svc.url);
    await media.refresh();
    expect(media.needs().size).toBe(0);
    svc.stop();
    const down = remote(svc.url);
    await down.refresh();
    expect(down.needs().size).toBe(0);
    expect(new Media().needs().size).toBe(0);
  });

  test("each route sends the documented body and returns the bytes or the text", async () => {
    const svc = fakeService([{ kind: "tts", provider: "free" }, { kind: "stt", provider: "free" }, { kind: "image", provider: "free" }, { kind: "video", provider: "free" }]);
    const media = remote(svc.url);
    await media.refresh();
    const dir = scratch();
    const audio = join(dir, "a.wav"); writeFileSync(audio, "sound");
    const picture = join(dir, "p.png"); writeFileSync(picture, PNG);

    expect(await media.pick("stt")!.run({ path: audio, language: "en" }, signal)).toEqual({ text: "hello there" });
    const tts = await media.pick("tts")!.run({ text: "hi" }, signal);
    expect(tts).toMatchObject({ mime: "audio/wav", seconds: 2 });
    expect(Buffer.from(tts.bytes).toString()).toBe("RIFF\x01\x02\x03");
    expect((await media.pick("image")!.run({ prompt: "a cat", size: "512x512", reference: picture }, signal)).mime).toBe("image/png");
    expect((await media.pick("video")!.run({ prompt: "waves", seconds: 5, image: picture }, signal)).mime).toBe("video/mp4");

    const body = (end: string) => svc.seen.find((s) => s.path.endsWith(end))!.body;
    expect(body("/stt")).toEqual({ audio: Buffer.from("sound").toString("base64"), language: "en" });
    expect(body("/tts")).toEqual({ text: "hi" });
    expect(body("/image")).toEqual({ prompt: "a cat", size: "512x512", reference: PNG.toString("base64") });
    expect(body("/video")).toEqual({ prompt: "waves", seconds: 5, image: PNG.toString("base64") });
    svc.stop();
  });

  test("the service's own sentence is what a refusal says, and a bad token says to sign in", async () => {
    const svc = fakeService([{ kind: "image", provider: "free" }]);
    const media = remote(svc.url);
    await media.refresh();
    await expect(media.pick("image")!.run({ prompt: "refuse" }, signal)).rejects.toThrow("You have used today's pictures.");
    const wrong = new Media({ server: () => ({ url: svc.url, token: "other" }) });
    await wrong.refresh();
    expect(wrong.needs().size).toBe(0);
    svc.stop();
  });

  test("a recording over 25 MB is refused before anything is sent", async () => {
    const svc = fakeService([{ kind: "stt", provider: "free" }]);
    const media = remote(svc.url);
    await media.refresh();
    const big = join(scratch(), "big.wav");
    writeFileSync(big, "x"); truncateSync(big, 26_000_000);
    await expect(media.pick("stt")!.run({ path: big }, signal)).rejects.toBeInstanceOf(MediaError);
    expect(svc.seen.some((s) => s.path.endsWith("/stt"))).toBe(false);
    svc.stop();
  });
});

describe.skipIf(win)("the engines on this computer", () => {
  const files = (dir: string) => { for (const f of ["whisper.bin", "voice.onnx", "sd.safetensors"]) writeFileSync(join(dir, f), "model"); };

  test("a local engine is offered only when its program and its model files exist", () => {
    const dir = scratch();
    const bin = program(dir, "whisper-cli", "echo hi");
    expect(new Media({ local: { stt: { bin, model: join(dir, "whisper.bin") } } }).has("stt")).toBe(false);
    files(dir);
    expect(new Media({ local: { stt: { bin, model: join(dir, "whisper.bin") } } }).has("stt")).toBe(true);
    expect(new Media({ local: { stt: { bin: join(dir, "missing"), model: join(dir, "whisper.bin") } } }).has("stt")).toBe(false);
    expect(new Media({ local: { tts: { engine: "kokoro", bin, model: join(dir, "voice.onnx") } } }).has("tts")).toBe(false);
  });

  test("speech to text runs whisper.cpp on a wav as it is, and converts anything else with ffmpeg", async () => {
    const dir = scratch(); files(dir);
    const log = join(dir, "args.txt");
    const whisper = program(dir, "whisper-cli", `echo "$@" > ${log}\nprintf '  hello   from\\n whisper \\n'`);
    const ffmpeg = program(dir, "ffmpeg", 'for last; do :; done; printf wav > "$last"');
    const wav = join(dir, "a.wav"); writeFileSync(wav, "x");
    const mp3 = join(dir, "a.mp3"); writeFileSync(mp3, "x");

    const plain = new Media({ local: { stt: { bin: whisper, model: join(dir, "whisper.bin"), language: "en" } }, which: () => undefined });
    expect(await plain.pick("stt")!.run({ path: wav }, signal)).toEqual({ text: "hello from whisper" });
    expect(readFileSync(log, "utf8")).toContain(`-m ${join(dir, "whisper.bin")} -f ${wav} -nt -np -l en`);
    await expect(plain.pick("stt")!.run({ path: mp3 }, signal)).rejects.toThrow("ffmpeg is needed");

    const converting = new Media({ local: { ffmpeg, stt: { bin: whisper, model: join(dir, "whisper.bin") } } });
    await converting.pick("stt")!.run({ path: mp3, language: "id" }, signal);
    expect(readFileSync(log, "utf8")).toMatch(/-f \S+in\.wav -nt -np -l id/);
  });

  test("text to speech: Piper gets the text on standard input, never in the arguments", async () => {
    const dir = scratch(); files(dir);
    const log = join(dir, "piper.txt");
    const piper = program(dir, "piper", `echo "$@" > ${log}\ncat >> ${log}\nwhile [ "$1" != "--output_file" ]; do shift; done\nprintf RIFFpiper > "$2"`);
    const media = new Media({ local: { tts: { bin: piper, model: join(dir, "voice.onnx") } } });
    const sound = await media.pick("tts")!.run({ text: "secret words" }, signal);
    expect(Buffer.from(sound.bytes).toString()).toBe("RIFFpiper");
    const said = readFileSync(log, "utf8");
    expect(said.split("\n")[0]).not.toContain("secret words");
    expect(said).toContain("secret words");
  });

  test("text to speech: Kokoro is given the text as a file and its voices", async () => {
    const dir = scratch(); files(dir);
    writeFileSync(join(dir, "voices.bin"), "v");
    const log = join(dir, "kokoro.txt");
    const kokoro = program(dir, "kokoro-tts", `echo "$@" > ${log}\ncat "$1" >> ${log}\nprintf RIFFkokoro > "$2"`);
    const media = new Media({ local: { tts: { engine: "kokoro", bin: kokoro, model: join(dir, "voice.onnx"), voices: join(dir, "voices.bin"), voice: "af_sarah" } } });
    expect(Buffer.from((await media.pick("tts")!.run({ text: "good morning" }, signal)).bytes).toString()).toBe("RIFFkokoro");
    expect(readFileSync(log, "utf8")).toContain("--voices");
    expect(readFileSync(log, "utf8")).toContain("--voice af_sarah");
    expect(readFileSync(log, "utf8")).toContain("good morning");
  });

  test("a picture: stable-diffusion.cpp gets the size, a prompt that looks like an option stays a value, and the program has no secret in its environment", async () => {
    const dir = scratch(); files(dir);
    const log = join(dir, "sd.txt");
    const sd = program(dir, "sd", `echo "$@" > ${log}\nenv | grep -c sk-do-not-leak >> ${log}\nwhile [ "$1" != "-o" ]; do shift; done\nprintf '\\211PNG\\r\\n\\032\\n' > "$2"`);
    const media = new Media({ local: { image: { bin: sd, model: join(dir, "sd.safetensors") } } });
    process.env.NAVVIED_TEST_API_KEY = "sk-do-not-leak";
    try {
      const made = await media.pick("image")!.run({ prompt: "-W 9999 a cat", size: "1024x576" }, signal);
      expect(made.mime).toBe("image/png");
      const said = readFileSync(log, "utf8");
      expect(said).toContain("-p  -W 9999 a cat");
      expect(said).toContain("-W 1024 -H 576");
      expect(said.trim().endsWith("0")).toBe(true);
    } finally { delete process.env.NAVVIED_TEST_API_KEY; }
    await expect(media.pick("image")!.run({ prompt: "x", size: "huge" }, signal)).rejects.toThrow("not like 512x512");
  });

  test("the settings of a turbo model go to stable-diffusion.cpp as it names them, and a model with none gets none", async () => {
    const dir = scratch(); files(dir);
    const log = join(dir, "sd2.txt");
    const sd = program(dir, "sd", `echo "$@" > ${log}\nwhile [ "$1" != "-o" ]; do shift; done\nprintf '\\211PNG\\r\\n\\032\\n' > "$2"`);
    await new Media({ local: { image: { bin: sd, model: join(dir, "sd.safetensors"), steps: 1, cfg: 1 } } }).pick("image")!.run({ prompt: "a cat" }, signal);
    expect(readFileSync(log, "utf8")).toContain("--steps 1 --cfg-scale 1");
    await new Media({ local: { image: { bin: sd, model: join(dir, "sd.safetensors") } } }).pick("image")!.run({ prompt: "a cat" }, signal);
    expect(readFileSync(log, "utf8")).not.toContain("--steps");
  });

  test("a program that fails is a sentence with its last line, and one that hangs is stopped", async () => {
    const dir = scratch(); files(dir);
    const bad = program(dir, "sd", 'echo "out of memory" >&2\nexit 3');
    const media = new Media({ local: { image: { bin: bad, model: join(dir, "sd.safetensors") } } });
    await expect(media.pick("image")!.run({ prompt: "x" }, signal)).rejects.toThrow("Drawing the picture failed (exit 3): out of memory");
    const slow = program(dir, "whisper-cli", "sleep 30");
    const wav = join(dir, "a.wav"); writeFileSync(wav, "x");
    const stopped = new AbortController();
    const hung = new Media({ local: { stt: { bin: slow, model: join(dir, "whisper.bin") } }, which: () => undefined }).pick("stt")!.run({ path: wav }, stopped.signal);
    setTimeout(() => stopped.abort(), 100);
    await expect(hung).rejects.toThrow("It was stopped.");
  });

  test("a local engine comes before the service, and the service serves what is not local", async () => {
    const dir = scratch(); files(dir);
    const svc = fakeService([{ kind: "stt", provider: "free" }, { kind: "tts", provider: "free" }]);
    const whisper = program(dir, "whisper-cli", "echo local words");
    const media = new Media({ local: { stt: { bin: whisper, model: join(dir, "whisper.bin") } }, server: () => ({ url: svc.url, token: "tok" }), which: () => undefined });
    await media.refresh();
    expect(media.pick("stt")!.local).toBe(true);
    expect(media.pick("tts")!.local).toBe(false);
    svc.stop();
  });
});
