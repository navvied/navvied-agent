import { mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { PictureInfo } from "@navvied/protocol";
import type { ToolContext } from "../types.ts";
import { writeAtomic } from "./text-file.ts";

/** The width and height a picture says in its own header (png, jpeg or webp), or none when it is none of those or the header is cut. */
export function pictureSize(b: Uint8Array): { width: number; height: number } | undefined {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const ascii = (at: number, n: number): string => String.fromCharCode(...b.subarray(at, at + n));
  if (b.length >= 24 && ascii(1, 3) === "PNG") return { width: v.getUint32(16), height: v.getUint32(20) };
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    for (let i = 2; i + 9 < b.length;) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1]!;
      if (marker === 0xff) { i++; continue; }
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { i += 2; continue; }
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { height: v.getUint16(i + 5), width: v.getUint16(i + 7) };
      i += 2 + v.getUint16(i + 2);
    }
    return undefined;
  }
  if (b.length >= 30 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
    const kind = ascii(12, 4);
    if (kind === "VP8X") return { width: 1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16)), height: 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16)) };
    if (kind === "VP8L") { const n = v.getUint32(21, true); return { width: 1 + (n & 0x3fff), height: 1 + ((n >> 14) & 0x3fff) }; }
    if (kind === "VP8 ") return { width: v.getUint16(26, true) & 0x3fff, height: v.getUint16(28, true) & 0x3fff };
  }
  return undefined;
}

/** What a picture file says of itself, for the step's card. */
export function pictureInfo(path: string, bytes: Uint8Array, mime: string): PictureInfo | undefined {
  const size = pictureSize(bytes);
  return size ? { path, bytes: bytes.length, ...size, mime } : undefined;
}

const KEEP = 50;

/**
 * Saves a picture a tool took into the tool's own folder (`ctx.folder`), oldest ones beyond the newest 50 taken away, and tells the step's card where it is. No folder given, no file:
 * the picture still goes to the model as before.
 */
export function keepPicture(ctx: ToolContext, tool: string, bytes: Uint8Array, mime: string, ext: string, now = Date.now()): PictureInfo | undefined {
  const dir = ctx.folder?.(tool);
  if (!dir) return undefined;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, `shot-${new Date(now).toISOString().replace(/[:.]/g, "-")}.${ext}`);
    writeAtomic(path, bytes);
    const info = pictureInfo(path, bytes, mime);
    if (!info) return undefined;
    ctx.report?.({ picture: info, media: { path, mime } });
    const old = readdirSync(dir).filter((f) => f.startsWith("shot-")).map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t).slice(KEEP);
    for (const o of old) { try { unlinkSync(join(dir, o.f)); } catch { /* it is gone */ } }
    return info;
  } catch { return undefined; }
}
