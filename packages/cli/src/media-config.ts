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
export interface MediaConfig extends LocalConfig { vision?: { model: string }; pdftoppm?: string }

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
    else if (kind === "image") out.image = { bin: extra("bin")!, model: extra("model")! };
    else {
      if (e.engine !== undefined && e.engine !== "piper" && e.engine !== "kokoro") return `"media.tts.engine" must be "piper" or "kokoro"`;
      if (e.engine === "kokoro" && !extra("voices")) return `"media.tts" with "kokoro" needs the voices file in "voices"`;
      out.tts = { bin: extra("bin")!, model: extra("model")!, ...(e.engine ? { engine: e.engine as "piper" | "kokoro" } : {}), ...(extra("voices") ? { voices: extra("voices")! } : {}), ...(extra("voice") ? { voice: extra("voice")! } : {}) };
    }
  }
  if (raw.vision !== undefined) {
    if (!isObj(raw.vision) || !text(raw.vision, "model")) return `"media.vision" needs the name of a model in "model"`;
    out.vision = { model: text(raw.vision, "model")! };
  }
  for (const key of ["ffmpeg", "pdftoppm"] as const) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] !== "string" || !raw[key]) return `"media.${key}" must be a path`;
    out[key] = raw[key] as string;
  }
  return out;
}
