import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { run } from "../media/run.ts";
import { MediaError } from "../media/types.ts";
import type { Tool } from "../types.ts";
import { attempt, providerOf, save, sizeWords, sourceFile } from "./media-files.ts";
import { clip, str } from "./util.ts";

const MOST_RECORDING = 500_000_000;
const VIDEOS = new Set([".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v"]);
const LANGUAGE = /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/;

export const transcribe: Tool = {
  name: "Transcribe",
  readOnly: true,
  fromOutside: true,
  needs: "stt",
  offeredWhen: ({ small, userText }) => !small && (/\b(transcri\w*|subtitles?|captions?|voice ?(note|memo|message)|recording|podcast|speech|dictat\w*|what (is|was|does) (said|he say|she say|they say))\b/i.test(userText) || /\.(mp3|wav|m4a|ogg|opus|flac|aac|mp4|mov|mkv|webm)\b/i.test(userText)),
  description: "Turn a sound or video file into text.",
  parameters: { type: "object", properties: { file_path: { type: "string" }, language: { type: "string" } }, required: ["file_path"] },
  title: (a) => `Transcribe ${str(a.file_path)}`,
  async run(a, ctx) {
    const provider = providerOf(ctx, "stt");
    if (typeof provider === "string") return provider;
    const from = sourceFile(ctx, a.file_path, MOST_RECORDING, "a recording");
    if (typeof from === "string") return from;
    const language = str(a.language).trim() || undefined;
    if (language && !LANGUAGE.test(language)) return `Error: language "${language}" is not a code like "en" or "id".`;
    const dir = mkdtempSync(join(tmpdir(), "navvied-media-"));
    try {
      return await attempt(async () => {
        let path = from.path;
        const ffmpeg = ctx.media?.program("ffmpeg");
        // A video is cut down to its sound first: the service takes at most 25 MB, and a program that reads sound only needs no picture.
        if (ffmpeg && VIDEOS.has(extname(path).toLowerCase())) {
          const sound = join(dir, "sound.mp3");
          const r = await run([ffmpeg, "-y", "-v", "error", "-i", path, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "32k", sound], { cwd: dir, ms: 300_000, signal: ctx.signal });
          if (r.code !== 0) throw new MediaError(`The sound of ${basename(path)} could not be taken out${r.err ? `: ${r.err.split("\n").at(-1)}` : "."}`);
          path = sound;
        }
        const { text } = await provider.run({ path, ...(language ? { language } : {}) }, ctx.signal);
        if (!text.trim()) return `No speech was found in ${from.path}.`;
        return clip(`Transcript of ${from.path} (${sizeWords(from.size)}):\n${text.trim()}`);
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  },
};

export const speak: Tool = {
  name: "Speak",
  readOnly: false,
  needs: "tts",
  offeredWhen: ({ small, userText }) => !small && /\b(speak|say (it|this|that)|read\b.{0,40}\b(aloud|out loud)|read out|narrat\w*|voice ?over|text.to.speech|tts|spoken|audio ?(file|version|book)|mp3|wav)\b/i.test(userText),
  description: "Read a text aloud into an audio file.",
  parameters: { type: "object", properties: { text: { type: "string" }, file_path: { type: "string" }, overwrite: { type: "boolean" } }, required: ["text"] },
  title: (a) => `Speak ${str(a.text).slice(0, 40).replace(/\s+/g, " ")}`,
  async run(a, ctx) {
    const provider = providerOf(ctx, "tts");
    if (typeof provider === "string") return provider;
    const text = str(a.text).trim();
    if (!text) return `Error: the text is empty. Retry: ${JSON.stringify({ text: "words to read aloud" })}`;
    return attempt(async () => {
      const sound = await provider.run({ text }, ctx.signal);
      const saved = save(ctx, a, "speech", "wav", sound);
      return sound.seconds ? `${saved.slice(0, -1)}, ${sound.seconds} seconds.` : saved;
    });
  },
};
