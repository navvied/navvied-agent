import type { LocalConfig } from "@navvied/engine";

/**
 * The `media` part of config.json: the engines on this computer, as a program and the model files it needs, and the model that looks at pictures. Paths only: nothing here is a secret,
 * nothing is downloaded, and an engine whose files are not there is simply not offered.
 *
 *   "media": {
 *     "stt":   { "bin": "/opt/whisper/whisper-cli", "model": "/opt/whisper/ggml-base.bin", "language": "en" },
 *     "tts":   { "engine": "piper", "bin": "/opt/piper/piper", "model": "/opt/piper/en_US-lessac.onnx" },
 *     "image": { "bin": "/opt/sd/sd", "model": "/opt/sd/model.safetensors" },
 *     "vision": { "model": "name of a model entry that sees pictures" },
 *     "ffmpeg": "/usr/bin/ffmpeg", "pdftoppm": "/usr/bin/pdftoppm"
 *   }
 */
export interface MediaConfig extends LocalConfig { vision?: { model: string } | { local: LocalVisionConfig }; pdftoppm?: string }

/** A model that looks at pictures and runs on this computer: the program that serves it, the model file and the file that lets it read pictures. Written by the setup of the Vision tool. */
export interface LocalVisionConfig { server: string; model: string; mmproj: string }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (o: Record<string, unknown>, key: string): string | undefined => (typeof o[key] === "string" && o[key] ? (o[key] as string) : undefined);

/** The `media` object read and checked; an error says which key is wrong, in words. */
export function parseMedia(raw: unknown): MediaConfig | string {
  if (!isObj(raw)) return `"media" must be an object`;
  const out: MediaConfig = {};
  for (const kind of ["stt", "tts", "image"] as const) {
    const e = raw[kind];
    if (e === undefined) continue;
    if (!isObj(e) || !text(e, "bin") || !text(e, "model")) return `"media.${kind}" needs a program in "bin" and a file in "model"`;
    const extra = (key: string): string | undefined => text(e, key);
    if (kind === "stt") out.stt = { bin: extra("bin")!, model: extra("model")!, ...(extra("language") ? { language: extra("language")! } : {}) };
    else if (kind === "image") {
      for (const k of ["steps", "cfg"] as const) if (e[k] !== undefined && (typeof e[k] !== "number" || !((e[k] as number) >= 0) || (k === "steps" && !Number.isInteger(e[k])))) return `"media.image.${k}" must be a number`;
      out.image = { bin: extra("bin")!, model: extra("model")!, ...(typeof e.steps === "number" && e.steps > 0 ? { steps: e.steps } : {}), ...(typeof e.cfg === "number" ? { cfg: e.cfg } : {}) };
    }
    else {
      if (e.engine !== undefined && e.engine !== "piper" && e.engine !== "kokoro") return `"media.tts.engine" must be "piper" or "kokoro"`;
      if (e.engine === "kokoro" && !extra("voices")) return `"media.tts" with "kokoro" needs the voices file in "voices"`;
      out.tts = { bin: extra("bin")!, model: extra("model")!, ...(e.engine ? { engine: e.engine as "piper" | "kokoro" } : {}), ...(extra("voices") ? { voices: extra("voices")! } : {}), ...(extra("voice") ? { voice: extra("voice")! } : {}) };
    }
  }
  if (raw.vision !== undefined) {
    const v = raw.vision;
    if (isObj(v) && isObj(v.local)) {
      const l = v.local;
      if (!text(l, "server") || !text(l, "model") || !text(l, "mmproj")) return `"media.vision.local" needs "server", "model" and "mmproj" (paths)`;
      out.vision = { local: { server: text(l, "server")!, model: text(l, "model")!, mmproj: text(l, "mmproj")! } };
    } else {
      if (!isObj(v) || !text(v, "model")) return `"media.vision" needs the name of a model in "model"`;
      out.vision = { model: text(v, "model")! };
    }
  }
  for (const key of ["ffmpeg", "pdftoppm"] as const) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] !== "string" || !raw[key]) return `"media.${key}" must be a path`;
    out[key] = raw[key] as string;
  }
  return out;
}
