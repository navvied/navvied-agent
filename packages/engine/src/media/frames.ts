import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { lastLine, run } from "./run.ts";
import { MediaError } from "./types.ts";

const MS = 120_000;
/** The longest side of a frame given to a model: larger pictures cost more and are seen no better. */
const SIDE = 1024;

export interface Frame { mime: string; data: string; at: number }

/** The length of a recording in seconds, as ffmpeg prints it when it is only asked to open the file. */
export async function lengthOf(ffmpeg: string, path: string, cwd: string, signal: AbortSignal): Promise<number> {
  const r = await run([ffmpeg, "-hide_banner", "-i", path], { cwd, ms: MS, signal });
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(r.err);
  if (!m) throw new MediaError(`${path} is not a video ffmpeg can open${lastLine(r.err) ? `: ${lastLine(r.err)}` : "."}`);
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/** `count` frames spread evenly over a video: the middle of each equal part, so the first and last black frames are skipped. */
export async function sampleFrames(ffmpeg: string, path: string, count: number, dir: string, signal: AbortSignal): Promise<{ seconds: number; frames: Frame[] }> {
  const seconds = await lengthOf(ffmpeg, path, dir, signal);
  const frames: Frame[] = [];
  for (let i = 0; i < count; i++) {
    const at = seconds > 0 ? (seconds * (i + 0.5)) / count : 0;
    const out = join(dir, `frame-${i}.jpg`);
    const r = await run([ffmpeg, "-y", "-v", "error", "-ss", at.toFixed(2), "-i", path, "-frames:v", "1", "-vf", `scale='min(${SIDE},iw)':-2`, "-q:v", "4", out], { cwd: dir, ms: MS, signal });
    if (r.code === 0 && existsSync(out)) frames.push({ mime: "image/jpeg", data: readFileSync(out).toString("base64"), at });
  }
  if (!frames.length) throw new MediaError(`No frame could be cut out of ${path}.`);
  return { seconds, frames };
}

/** One page of a PDF as a picture. */
export async function pageImage(pdftoppm: string, path: string, page: number, dir: string, signal: AbortSignal): Promise<Frame> {
  const stem = join(dir, "page");
  const r = await run([pdftoppm, "-png", "-r", "100", "-f", String(page), "-l", String(page), "-singlefile", path, stem], { cwd: dir, ms: MS, signal });
  if (r.code !== 0 || !existsSync(`${stem}.png`)) throw new MediaError(`Page ${page} of ${path} could not be drawn${lastLine(r.err) ? `: ${lastLine(r.err)}` : "."}`);
  return { mime: "image/png", data: readFileSync(`${stem}.png`).toString("base64"), at: page };
}

/** The longest side of a picture given to a model when it is made smaller, and the size from which it is. */
export const SHRINK_SIDE = 1568, SHRINK_FROM = 1_000_000;

/** A large picture as a JPEG with its longest side at most `SHRINK_SIDE`; nothing when ffmpeg cannot do it (the picture is then sent as it is). */
export async function shrink(ffmpeg: string, path: string, dir: string, signal: AbortSignal): Promise<Frame | undefined> {
  const out = join(dir, "small.jpg");
  const r = await run([ffmpeg, "-y", "-v", "error", "-i", path, "-frames:v", "1", "-vf", `scale='min(${SHRINK_SIDE},iw)':'min(${SHRINK_SIDE},ih)':force_original_aspect_ratio=decrease`, "-q:v", "3", out], { cwd: dir, ms: MS, signal });
  return r.code === 0 && existsSync(out) ? { mime: "image/jpeg", data: readFileSync(out).toString("base64"), at: 0 } : undefined;
}
