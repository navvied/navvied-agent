import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, extname } from "node:path";
import type { MediaProvider } from "../media/types.ts";
import { MediaError } from "../media/types.ts";
import type { Tool, ToolContext } from "../types.ts";
import { wrote } from "./file-state.ts";
import { pictureInfo } from "./picture-file.ts";
import { writeAtomic } from "./text-file.ts";
import { place, str } from "./util.ts";

/** A size as a person says it. */
export function sizeWords(n: number): string {
  return n < 1000 ? `${n} bytes` : n < 1_000_000 ? `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)} KB` : `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)} MB`;
}

/** A file the person named, to be read: a regular file inside the project, not larger than `most` bytes. A sentence when it is not. */
export function sourceFile(ctx: ToolContext, p: unknown, most: number, what: string): { path: string; size: number } | string {
  if (!str(p).trim()) return `Error: file_path is empty. Retry: ${JSON.stringify({ file_path: "path of the file" })}`;
  const path = place(ctx, p);
  if (!existsSync(path)) return `Error: ${path} does not exist. Use Glob to find the right path.`;
  const st = statSync(path);
  if (!st.isFile()) return `Error: ${path} is not a file.`;
  if (!st.size) return `Error: ${path} is empty.`;
  if (st.size > most) return `Error: ${path} is ${sizeWords(st.size)}; ${what} may be at most ${sizeWords(most)}.`;
  return { path, size: st.size };
}

const EXT: Record<string, string> = { "audio/wav": "wav", "audio/x-wav": "wav", "audio/mpeg": "mp3", "audio/ogg": "ogg", "audio/flac": "flac", "audio/mp4": "m4a", "audio/aac": "aac", "audio/opus": "opus", "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov" };

/** The type of a sound, picture or video file by its name, for one that was not made by a provider (a video the person gave to Watch). */
export function mimeOfFile(path: string): string {
  const ext = extname(path).slice(1).toLowerCase();
  const made = Object.entries(EXT).find(([, e]) => e === ext)?.[0];
  return made ?? (ext === "m4v" ? "video/mp4" : ext === "mkv" ? "video/x-matroska" : ext === "avi" ? "video/x-msvideo" : ext === "jpeg" ? "image/jpeg" : "application/octet-stream");
}

/**
 * Where a made file goes, and saving it: the named path (inside the project), or `stem` and the next free number when none is named. A file that is already there is never
 * replaced unless the call says so. The result names the path and the size.
 */
export function save(ctx: ToolContext, a: Record<string, unknown>, stem: string, fallback: string, made: { bytes: Uint8Array; mime: string; seconds?: number }): string {
  const ext = EXT[made.mime] ?? fallback;
  const named = str(a.file_path).trim();
  let path: string;
  if (named) {
    path = place(ctx, extname(named) ? named : `${named}.${ext}`);
    if (existsSync(path) && (statSync(path).isDirectory() || a.overwrite !== true)) return `Error: ${path} ${statSync(path).isDirectory() ? "is a directory" : "already exists"}. Choose another file_path${statSync(path).isDirectory() ? "" : ", or send overwrite: true to replace it"}.`;
  } else {
    let n = 1;
    do path = place(ctx, `${stem}${n === 1 ? "" : `-${n}`}.${ext}`); while (existsSync(path) && ++n < 1000);
  }
  mkdirSync(dirname(path), { recursive: true });
  writeAtomic(path, made.bytes);
  wrote(ctx, path, made.bytes);
  const picture = made.mime.startsWith("image/") ? pictureInfo(path, made.bytes, made.mime) : undefined;
  ctx.report?.({ ...(picture ? { picture } : {}), media: { path, mime: made.mime, ...(typeof made.seconds === "number" ? { seconds: made.seconds } : {}) } });
  return `Saved ${path} (${sizeWords(made.bytes.length)}).`;
}

/** The provider of a kind, or the sentence that says what is missing. */
export function providerOf<K extends "stt" | "tts" | "image" | "video">(ctx: ToolContext, kind: K): MediaProvider<K> | string {
  return ctx.media?.pick(kind) ?? "Error: no provider is set up for this on this computer.";
}

/** A failure of a provider as a sentence for the model; anything unexpected is passed on. */
export async function attempt(work: () => Promise<string>): Promise<string> {
  try { return await work(); } catch (e) { if (e instanceof MediaError) return `Error: ${e.message}`; throw e; }
}
