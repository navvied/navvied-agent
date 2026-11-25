import { deflateRawSync } from "node:zlib";

export interface ZipFile {
  name: string;
  data?: string | Buffer;
  /** Stored as is (method 0) instead of compressed. */
  store?: boolean;
  /** The Unix mode kept in the entry (a link is `0o120777`). */
  mode?: number;
  /** General purpose flags, for example 1 for encrypted. */
  flags?: number;
  /** What the directory says the size is, when it should lie. */
  usize?: number;
}

/** A zip file made by hand, so an entry can have any name, mode, flags or a size it lies about. */
export function makeZip(files: ZipFile[]): Buffer {
  const locals: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const raw = Buffer.from(f.data ?? ""), method = f.store || f.name.endsWith("/") ? 0 : 8, packed = method === 0 ? raw : deflateRawSync(raw);
    const n = Buffer.from(f.name), size = f.usize ?? raw.length;
    const head = Buffer.alloc(30); head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(f.flags ?? 0, 6); head.writeUInt16LE(method, 8); head.writeUInt32LE(packed.length, 18); head.writeUInt32LE(size, 22); head.writeUInt16LE(n.length, 26);
    const entry = Buffer.alloc(46); entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(f.mode === undefined ? 20 : 0x0314, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(f.flags ?? 0, 8); entry.writeUInt16LE(method, 10); entry.writeUInt32LE(packed.length, 20); entry.writeUInt32LE(size, 24); entry.writeUInt16LE(n.length, 28); entry.writeUInt32LE(((f.mode ?? 0) << 16) >>> 0, 38); entry.writeUInt32LE(offset, 42);
    locals.push(head, n, packed); central.push(entry, n);
    offset += 30 + n.length + packed.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}
