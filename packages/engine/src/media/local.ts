import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { lastLine, run } from "./run.ts";
import { MediaError, type MediaProvider, type Requests } from "./types.ts";

/**
 * The engines that can run on this computer, as the configuration names them: a program and the model file it needs. Nothing here is downloaded or started by itself: a provider
 * is offered only when its program and every file it names exist, and it holds no secret.
 */
export interface LocalConfig {
  /** whisper.cpp: `bin` is `whisper-cli`, `model` a ggml file. */
  stt?: { bin: string; model: string; language?: string };
  /** Piper (`model` is the voice, an .onnx file) or Kokoro (`model` and `voices` files, an optional `voice`). */
  tts?: { engine?: "piper" | "kokoro"; bin: string; model: string; voices?: string; voice?: string };
  /** stable-diffusion.cpp: `bin` is `sd-cli` (or `sd`), `model` a checkpoint; `steps` and `cfg` are the model's own settings (a turbo model needs 1 step and a scale of 1). */
  image?: { bin: string; model: string; steps?: number; cfg?: number };
  /** The program that cuts sound and frames out of recordings (default: the one on the path). */
  ffmpeg?: string;
}

/** How long one run may take. */
const MS = { stt: 600_000, tts: 120_000, image: 600_000, convert: 300_000 };
const MOST_TEXT = 20_000, MOST_PROMPT = 2_000;
const PICTURE = /^(\d{2,4})x(\d{2,4})$/;
const SOUND = new Set([".wav"]);

/** A folder of its own for one run, removed whatever happens. */
async function scratch<T>(use: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "navvied-media-"));
  try { return await use(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** A value that could be read as an option by the program that gets it as one word. */
const asValue = (s: string): string => (s.startsWith("-") ? ` ${s}` : s);

const exists = (...paths: (string | undefined)[]): boolean => paths.every((p) => p === undefined || (existsSync(p) && statSync(p).isFile()));

function failed(what: string, code: number, err: string): MediaError {
  return new MediaError(`${what} failed (exit ${code})${lastLine(err) ? `: ${lastLine(err)}` : "."}`);
}

export interface Finders { which(name: string): string | undefined }

/** whisper.cpp reads 16 kHz wav only: anything else is converted first, which needs ffmpeg. */
async function wavOf(path: string, dir: string, ffmpeg: string | undefined, signal: AbortSignal): Promise<string> {
  if (!ffmpeg) {
    if (SOUND.has(extname(path).toLowerCase())) return path;
    throw new MediaError("This recording is not a wav file, and ffmpeg is needed to convert it. Install ffmpeg or give a wav file.");
  }
  const out = join(dir, "in.wav");
  const r = await run([ffmpeg, "-y", "-v", "error", "-i", path, "-vn", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", out], { cwd: dir, ms: MS.convert, signal });
  if (r.code !== 0 || !existsSync(out)) throw failed("Converting the recording", r.code, r.err);
  return out;
}

export function whisper(c: NonNullable<LocalConfig["stt"]>, ffmpeg: () => string | undefined): MediaProvider<"stt"> {
  return {
    kind: "stt", id: "whisper.cpp", paid: false, local: true,
    usable: () => exists(c.bin, c.model),
    run: (req: Requests["stt"], signal) => scratch(async (dir) => {
      const wav = await wavOf(req.path, dir, ffmpeg(), signal);
      const language = req.language ?? c.language;
      const r = await run([c.bin, "-m", c.model, "-f", wav, "-nt", "-np", ...(language ? ["-l", language] : [])], { cwd: dir, ms: MS.stt, signal });
      if (r.code !== 0) throw failed("Transcribing", r.code, r.err);
      return { text: r.out.toString("utf8").replace(/\s+/g, " ").trim() };
    }),
  };
}

export function speech(c: NonNullable<LocalConfig["tts"]>): MediaProvider<"tts"> {
  const kokoro = c.engine === "kokoro";
  return {
    kind: "tts", id: kokoro ? "Kokoro" : "Piper", paid: false, local: true,
    usable: () => exists(c.bin, c.model, kokoro ? (c.voices ?? "") : undefined),
    run: ({ text }: Requests["tts"], signal) => scratch(async (dir) => {
      if (text.length > MOST_TEXT) throw new MediaError(`The text is ${text.length} characters; at most ${MOST_TEXT} are read at once.`);
      const out = join(dir, "speech.wav");
      let r;
      if (kokoro) {
        const input = join(dir, "text.txt");
        writeFileSync(input, text);
        r = await run([c.bin, input, out, "--model", c.model, "--voices", c.voices!, ...(c.voice ? ["--voice", c.voice] : [])], { cwd: dir, ms: MS.tts, signal });
      } else r = await run([c.bin, "--model", c.model, "--output_file", out], { cwd: dir, ms: MS.tts, signal, stdin: text });
      if (r.code !== 0 || !existsSync(out)) throw failed("Reading the text aloud", r.code, r.err);
      return { bytes: readFileSync(out), mime: "audio/wav" };
    }),
  };
}

export function diffusion(c: NonNullable<LocalConfig["image"]>): MediaProvider<"image"> {
  return {
    kind: "image", id: "stable-diffusion.cpp", paid: false, local: true,
    usable: () => exists(c.bin, c.model),
    run: (req: Requests["image"], signal) => scratch(async (dir) => {
      if (req.prompt.length > MOST_PROMPT) throw new MediaError(`The description is ${req.prompt.length} characters; at most ${MOST_PROMPT} are used.`);
      const size = PICTURE.exec(req.size ?? "512x512");
      if (!size) throw new MediaError(`The size "${req.size}" is not like 512x512.`);
      const out = join(dir, "picture.png");
      const r = await run([c.bin, "-m", c.model, "-p", asValue(req.prompt), "-o", out, "-W", size[1]!, "-H", size[2]!, ...(c.steps ? ["--steps", String(c.steps)] : []), ...(c.cfg !== undefined ? ["--cfg-scale", String(c.cfg)] : []), ...(req.reference ? ["-i", req.reference] : [])], { cwd: dir, ms: MS.image, signal });
      if (r.code !== 0 || !existsSync(out)) throw failed("Drawing the picture", r.code, r.err);
      return { bytes: readFileSync(out), mime: "image/png" };
    }),
  };
}

/** The local providers the configuration names; `Media` offers one only while its files exist. */
export function localProviders(c: LocalConfig, find: Finders): MediaProvider[] {
  const ffmpeg = (): string | undefined => c.ffmpeg ?? find.which("ffmpeg") ?? undefined;
  return [
    ...(c.stt ? [whisper(c.stt, ffmpeg)] : []),
    ...(c.tts ? [speech(c.tts)] : []),
    ...(c.image ? [diffusion(c.image)] : []),
  ];
}
