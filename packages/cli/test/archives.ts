import { deflateRawSync } from "node:zlib";

/** Tiny archives made by hand, for tests: the bytes of a tar and of a zip. */
export interface TarEntry { name: string; body?: string | Buffer; type?: string; mode?: number; link?: string; prefix?: string }

function header(e: TarEntry, size: number): Buffer {
  const h = Buffer.alloc(512);
  h.write(e.name, 0, 100, "utf8");
  h.write(`${(e.mode ?? 0o644).toString(8).padStart(7, "0")}\0`, 100);
  h.write("0000000\0", 108); h.write("0000000\0", 116);
  h.write(`${size.toString(8).padStart(11, "0")}\0`, 124);
  h.write("00000000000\0", 136);
  h.fill(0x20, 148, 156);
  h.write(e.type ?? "0", 156);
  if (e.link) h.write(e.link, 157, 100, "utf8");
  h.write("ustar\0", 257); h.write("00", 263);
  if (e.prefix) h.write(e.prefix, 345, 155, "utf8");
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return h;
}

export function tar(entries: TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const body = Buffer.from(e.body ?? "");
    parts.push(header(e, body.length), body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

export function zip(entries: { name: string; body?: string; mode?: number; flags?: number; store?: boolean; lie?: number }[], o: { zip64?: boolean } = {}): Buffer {
  const out: Buffer[] = [], central: Buffer[] = [];
  let at = 0;
  for (const e of entries) {
    const raw = Buffer.from(e.body ?? ""), data = e.store ? raw : deflateRawSync(raw), name = Buffer.from(e.name);
    const size = e.lie ?? raw.length;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(e.flags ?? 0, 6); lh.writeUInt16LE(e.store ? 0 : 8, 8);
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(size, 22); lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(0x031e, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(e.flags ?? 0, 8); ch.writeUInt16LE(e.store ? 0 : 8, 10);
    ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(size, 24); ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(((e.mode ?? 0o100644) << 16) >>> 0, 38); ch.writeUInt32LE(at, 42);
    out.push(lh, name, data);
    central.push(ch, name);
    at += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(o.zip64 ? 0xffff : entries.length, 8); end.writeUInt16LE(o.zip64 ? 0xffff : entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(at, 16);
  return Buffer.concat([...out, cd, end]);
}
