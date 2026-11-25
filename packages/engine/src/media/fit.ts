import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyFile } from "@navvied/protocol";
import { run } from "./run.ts";

/** The longest side of a picture given to a model, and the size from which a picture is made smaller even when its sides are not known. */
export const SIDE = 1568, SHRINK_FROM = 1_000_000;
const MS = 120_000;

export interface Image { mime: string; data: string }
export interface Shrinker { kind: "ffmpeg" | "magick" | "convert"; path: string }

/** The program on this computer that makes a picture smaller: what `which` finds first of these. `convert` is not looked for on Windows, where it is another program. */
export function findShrinker(which: (name: string) => string | undefined, ffmpeg?: string): Shrinker | undefined {
  if (ffmpeg) return { kind: "ffmpeg", path: ffmpeg };
  const kinds: Shrinker["kind"][] = process.platform === "win32" ? ["ffmpeg", "magick"] : ["ffmpeg", "magick", "convert"];
  for (const kind of kinds) { const path = which(kind); if (path) return { kind, path }; }
  return undefined;
}

/** The width and height of a PNG, JPEG or GIF from its first bytes; nothing for other pictures. */
export function sides(b: Uint8Array): { w: number; h: number } | undefined {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.length > 24 && v.getUint32(0) === 0x89504e47) return { w: v.getUint32(16), h: v.getUint32(20) };
  if (b.length > 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return { w: v.getUint16(6, true), h: v.getUint16(8, true) };
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    for (let i = 2; i + 9 < b.length;) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1]!;
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { w: v.getUint16(i + 7), h: v.getUint16(i + 5) };
      i += m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01 ? 2 : 2 + v.getUint16(i + 2);
    }
  }
  return undefined;
}

/** A JPEG with its longest side at most `SIDE`; nothing when the program cannot do it. */
export async function shrink(s: Shrinker, path: string, mime: string, dir: string, signal: AbortSignal): Promise<Image | undefined> {
  const out = join(dir, "small.jpg");
  const argv = s.kind === "ffmpeg"
    ? [s.path, "-y", "-v", "error", "-i", path, "-frames:v", "1", "-vf", `scale='min(${SIDE},iw)':'min(${SIDE},ih)':force_original_aspect_ratio=decrease`, "-q:v", "3", out]
    : [s.path, mime === "image/gif" ? `${path}[0]` : path, "-resize", `${SIDE}x${SIDE}>`, "-quality", "82", out];
  const r = await run(argv, { cwd: dir, ms: MS, signal });
  return r.code === 0 && existsSync(out) ? { mime: "image/jpeg", data: readFileSync(out).toString("base64") } : undefined;
}

/**
 * A picture as it goes to a model, for pictures of files and for pages drawn from a PDF alike: made smaller (JPEG, longest side `SIDE`) when it is larger than
 * `SHRINK_FROM` or any side is, and sent as it is when it is not or when nothing on this computer can make it smaller.
 */
export async function fit(s: Shrinker | undefined, path: string, bytes: Uint8Array, dir: string, signal: AbortSignal): Promise<Image & { smaller: boolean }> {
  const kind = classifyFile(bytes), mime = kind.kind === "image" ? kind.mime : "image/png";
  const d = sides(bytes);
  const big = bytes.length > SHRINK_FROM || (d !== undefined && Math.max(d.w, d.h) > SIDE);
  const small = s && big ? await shrink(s, path, mime, dir, signal) : undefined;
  return small ? { ...small, smaller: true } : { mime, data: Buffer.from(bytes).toString("base64"), smaller: false };
}
