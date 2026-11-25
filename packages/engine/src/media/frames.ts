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

