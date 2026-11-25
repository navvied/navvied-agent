import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { zipEntries, type Entry } from "./tools/documents.ts";

export interface ZipLimits { files: number; file: number; unpacked: number }

/** A file that unpacks to more than this must have been stored with a believable ratio; a zip bomb is thousands to one. */
const RATIO = 200, RATIO_FROM = 1024 * 1024;
const LOCAL = 0x04034b50, ENCRYPTED = 1;
const S_IFMT = 0o170000, S_IFREG = 0o100000, S_IFDIR = 0o040000;

export const isZip = (buf: Uint8Array): boolean => buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 3 || buf[2] === 5);

const leaves = (name: string): boolean => name.startsWith("/") || name.startsWith("\\") || /^[A-Za-z]:/.test(name) || name.includes("\0") || name.split(/[\\/]/).includes("..");

function bytesOf(buf: Buffer, e: Entry, limits: ZipLimits): Buffer | string {
  if (e.offset + 30 > buf.length || buf.readUInt32LE(e.offset) !== LOCAL) return `${e.name} is damaged`;
  const start = e.offset + 30 + buf.readUInt16LE(e.offset + 26) + buf.readUInt16LE(e.offset + 28);
  if (start + e.size > buf.length) return `${e.name} is damaged`;
  const data = buf.subarray(start, start + e.size);
  if (e.method === 0) return e.size === e.usize ? data : `${e.name} is damaged`;
  try {
    const raw = inflateRawSync(data, { maxOutputLength: Math.min(e.usize, limits.file) + 1 });
    return raw.length === e.usize ? raw : `${e.name} is not the size it says`;
  } catch { return `${e.name} is damaged or larger than it says`; }
}

/**
 * Unpacks a zip read as hostile input, with nothing but the standard library. Refused: paths that leave the folder, links, encrypted
 * or unusual files, the same name twice, too many files, a file or a total that is too large, and a ratio that is a bomb's.
 * Returns the reason, or nothing when it was unpacked.
 */
export function unzipTo(archive: Buffer, into: string, limits: ZipLimits): string | undefined {
  let entries: Entry[];
  try { entries = zipEntries(archive, true); } catch { return "the archive cannot be read"; }
  if (entries.length > limits.files * 2) return `the archive has more than ${limits.files * 2} entries`;
  const seen = new Set<string>();
  let total = 0;
  for (const e of entries) {
    const dir = e.name.endsWith("/");
    if (leaves(e.name)) return "the archive has a path that leaves its folder";
    const key = e.name.replace(/\/+$/, "").toLowerCase();
    if (seen.has(key)) return `the archive has ${e.name} twice`;
    seen.add(key);
    if (e.unixMode !== undefined && (e.unixMode & S_IFMT) !== 0 && (e.unixMode & S_IFMT) !== (dir ? S_IFDIR : S_IFREG)) return `the archive has a link or a special file (${e.name}), which a plugin may not have`;
    if (dir) continue;
    if (e.flags & ENCRYPTED) return `${e.name} is encrypted`;
    if (e.method !== 0 && e.method !== 8) return `${e.name} is packed in a way that is not supported`;
    if (e.usize > limits.file) return `${e.name} is larger than ${limits.file / 1024 / 1024} MB`;
    if (e.usize > RATIO_FROM && e.usize > e.size * RATIO) return `${e.name} is packed far tighter than a real file can be`;
    total += e.usize;
    if (total > limits.unpacked) return `the archive is larger than ${limits.unpacked / 1024 / 1024} MB when unpacked`;
  }
  for (const e of entries) {
    if (e.name.endsWith("/")) continue;
    const data = bytesOf(archive, e, limits);
    if (typeof data === "string") return data;
    const path = join(into, ...e.name.split("/").filter(Boolean));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, data, { mode: e.unixMode !== undefined && e.unixMode & 0o100 ? 0o755 : 0o644 });
  }
  return undefined;
}
