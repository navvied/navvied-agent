import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, symlinkSync, writeSync } from "node:fs";
import { createReadStream } from "node:fs";
import { join, posix, sep } from "node:path";
import { createGunzip, inflateRawSync } from "node:zlib";

/**
 * Archives are taken apart here, by this program, and never by a program found on the path: the file was proven by its hash, and what it holds is still treated as hostile.
 * Everything made is owner-only (0700 for folders and programs, 0600 for the rest), names that leave the folder are refused, and so are links that could lead out of it,
 * devices, hard links, encrypted or 64-bit zip entries, and any archive that grows past the limits.
 */
export interface Limits {
  /** Files, folders and links together. */
  entries: number;
  /** Bytes of everything written. */
  bytes: number;
  /** Bytes of one file. */
  entryBytes: number;
  /** Folders deep. */
  depth: number;
}

export const LIMITS: Limits = { entries: 4000, bytes: 1_500_000_000, entryBytes: 300_000_000, depth: 10 };

export class ArchiveError extends Error {}

const refuse = (why: string): never => { throw new ArchiveError(why); };

/** The name of an entry as a clean relative path, or a refusal. */
function cleanName(raw: string, depth: number): string {
  const name = raw.replace(/^(\.\/)+/, "").replace(/\/+$/, "");
  if (!name || name === ".") return "";
  if (name.length > 400 || name.includes("\0") || name.includes("\\") || name.startsWith("/") || /^[A-Za-z]:/.test(name)) return refuse(`The archive has a name that is not allowed: ${JSON.stringify(raw.slice(0, 60))}.`);
  const parts = name.split("/");
  if (parts.some((p) => p === ".." || p === "" || p === ".")) return refuse(`The archive has a name that leaves its folder: ${JSON.stringify(raw.slice(0, 60))}.`);
  if (parts.length > depth) return refuse("The archive has folders nested too deep.");
  return name;
}

/** Where entries are written: one folder, nothing outside it, nothing through a link. */
class Sink {
  #entries = 0;
  #bytes = 0;
  readonly #made = new Set<string>();
  constructor(readonly root: string, readonly limits: Limits) {}

  #count(): void { if (++this.#entries > this.limits.entries) refuse("The archive has too many files."); }

  /** The folders down to `rel`, made one by one: a component that is a link or a file stops it. */
  #parents(rel: string): void {
    let at = this.root;
    for (const part of rel.split("/")) {
      at = join(at, part);
      let st;
      try { st = lstatSync(at); } catch { mkdirSync(at, { mode: 0o700 }); continue; }
      if (!st.isDirectory()) refuse("The archive writes through something that is not a folder.");
    }
  }

  dir(rel: string): void {
    if (!rel || this.#made.has(rel)) return;
    this.#count();
    this.#made.add(rel);
    this.#parents(rel);
    chmodSync(join(this.root, rel), 0o700);
  }

  /** Opens a new file (never one that exists: a name twice in one archive is refused). */
  open(rel: string, executable: boolean): { write(chunk: Uint8Array): void; close(): void } {
    this.#count();
    const parent = posix.dirname(rel);
    if (parent !== ".") this.#parents(parent);
    let fd: number;
    try { fd = openSync(join(this.root, rel), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, executable ? 0o700 : 0o600); } catch { return refuse(`The archive has the name ${JSON.stringify(rel.slice(0, 60))} twice, or it cannot be written.`); }
    let own = 0;
    return {
      write: (chunk) => {
        own += chunk.length;
        this.#bytes += chunk.length;
        if (own > this.limits.entryBytes) refuse("A file in the archive is larger than is allowed.");
        if (this.#bytes > this.limits.bytes) refuse("The archive is larger than is allowed when taken apart.");
        writeSync(fd, chunk);
      },
      close: () => { closeSync(fd); },
    };
  }

  /** A link that points inside the folder, at something that is not the folder itself. */
  link(rel: string, target: string): void {
    if (!target || target.length > 400 || target.includes("\0") || target.includes("\\") || target.startsWith("/") || /^[A-Za-z]:/.test(target)) refuse("The archive has a link that is not allowed.");
    const inside = posix.normalize(posix.join(posix.dirname(rel), target));
    if (inside === "." || inside === ".." || inside.startsWith("../")) refuse("The archive has a link that leads out of its folder.");
    this.#count();
    const parent = posix.dirname(rel);
    if (parent !== ".") this.#parents(parent);
    try { symlinkSync(target, join(this.root, rel)); } catch { refuse(`The archive has the name ${JSON.stringify(rel.slice(0, 60))} twice, or it cannot be written.`); }
  }

  /** Whatever the archive made is inside the folder once every link is followed. */
  verify(): void {
    const root = realpathSync(this.root);
    const walk = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        const real = realpathSync(p);
        if (real !== root && !real.startsWith(root + sep)) refuse("The archive made something outside its folder.");
        if (e.isDirectory()) walk(p);
      }
    };
    walk(this.root);
  }
}

/** Pulls exact numbers of bytes out of a stream of chunks. */
class Pull {
  readonly #it: AsyncIterator<Buffer>;
  #buf: Buffer = Buffer.alloc(0);
  constructor(src: AsyncIterable<Buffer>) { this.#it = src[Symbol.asyncIterator](); }
  async #more(): Promise<boolean> {
    const r = await this.#it.next();
    if (r.done) return false;
    this.#buf = this.#buf.length ? Buffer.concat([this.#buf, r.value]) : r.value;
    return true;
  }
  /** `n` bytes, nothing when the stream ended before the first of them. */
  async exact(n: number): Promise<Buffer | undefined> {
    while (this.#buf.length < n) if (!(await this.#more())) return this.#buf.length ? refuse("The archive ends too early.") : undefined;
    const out = this.#buf.subarray(0, n);
    this.#buf = this.#buf.subarray(n);
    return out;
  }
  async each(n: number, f: (c: Buffer) => void): Promise<void> {
    for (let left = n; left > 0;) {
      if (!this.#buf.length && !(await this.#more())) refuse("The archive ends too early.");
      const c = this.#buf.subarray(0, Math.min(left, this.#buf.length));
      this.#buf = this.#buf.subarray(c.length);
      left -= c.length;
      f(c);
    }
  }
}

const field = (h: Buffer, at: number, n: number): string => { const raw = h.subarray(at, at + n); const end = raw.indexOf(0); return raw.subarray(0, end < 0 ? n : end).toString("utf8"); };
function number(h: Buffer, at: number, n: number): number {
  if (h[at]! & 0x80) { let v = 0; for (let i = 1; i < n; i++) v = v * 256 + h[at + i]!; return v; }
  const v = parseInt(field(h, at, n).trim() || "0", 8);
  return Number.isNaN(v) ? refuse("The archive has a header that cannot be read.") : v;
}

const MOST_META = 65_536;

/** The `path`, `linkpath` and `size` records of an extended header. */
function paxOf(body: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  for (let at = 0; at < body.length;) {
    const sp = body.indexOf(0x20, at);
    const len = Number(body.subarray(at, sp).toString());
    if (sp < 0 || !(len > sp - at + 1) || at + len > body.length) return refuse("The archive has a header that cannot be read.");
    const rec = body.subarray(sp + 1, at + len - 1).toString("utf8");
    const eq = rec.indexOf("=");
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    at += len;
  }
  return out;
}

async function untar(src: AsyncIterable<Buffer>, sink: Sink): Promise<void> {
  const pull = new Pull(src);
  let longName: string | undefined, longLink: string | undefined, pax: Record<string, string> = {};
  for (;;) {
    const h = await pull.exact(512);
    if (!h || h.every((b) => b === 0)) return;
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i]!;
    if (sum !== number(h, 148, 8)) refuse("The archive is damaged: a header does not add up.");
    const type = String.fromCharCode(h[156]! || 48);
    let size = number(h, 124, 12);
    const padded = Math.ceil(size / 512) * 512;
    if (type === "x" || type === "g" || type === "L" || type === "K") {
      if (size > MOST_META) refuse("The archive has a header that is too long.");
      const body = (await pull.exact(padded))!.subarray(0, size);
      if (type === "x") pax = { ...pax, ...paxOf(body) };
      else if (type === "L") longName = body.toString("utf8").replace(/\0.*$/s, "");
      else if (type === "K") longLink = body.toString("utf8").replace(/\0.*$/s, "");
      continue;
    }
    const prefix = field(h, 345, 155);
    const named = pax.path ?? longName ?? (prefix && field(h, 257, 5) === "ustar" ? `${prefix}/${field(h, 0, 100)}` : field(h, 0, 100));
    const target = pax.linkpath ?? longLink ?? field(h, 157, 100);
    if (pax.size !== undefined) size = Number(pax.size);
    pax = {}; longName = longLink = undefined;
    const rel = cleanName(named, sink.limits.depth);
    const mode = number(h, 100, 8);
    if (type === "5") { sink.dir(rel); continue; }
    if (type === "2") { if (!rel) refuse("The archive has a link with no name."); sink.link(rel, target); continue; }
    if (type !== "0" && type !== "7") return refuse(`The archive has an entry of a kind that is not allowed (${JSON.stringify(type)}).`);
    if (!rel) refuse("The archive has a file with no name.");
    const out = sink.open(rel, (mode & 0o111) !== 0);
    try { await pull.each(size, (c) => { out.write(c); }); } finally { out.close(); }
    const pad = Math.ceil(size / 512) * 512 - size;
    if (pad) await pull.exact(pad);
  }
}

function unzip(file: string, sink: Sink): void {
  const fd = openSync(file, "r");
  try {
    const length = fstatSync(fd).size;
    const read = (at: number, n: number): Buffer => {
      if (at < 0 || n < 0 || at + n > length) refuse("The archive ends too early.");
      const b = Buffer.alloc(n);
      if (n && readSync(fd, b, 0, n, at) !== n) refuse("The archive ends too early.");
      return b;
    };
    const tailAt = Math.max(0, length - 65_557);
    const tail = read(tailAt, length - tailAt);
    const end = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (end < 0) refuse("The file is not a zip archive.");
    const count = tail.readUInt16LE(end + 10), cdSize = tail.readUInt32LE(end + 12), cdAt = tail.readUInt32LE(end + 16);
    if (count === 0xffff || cdSize === 0xffffffff || cdAt === 0xffffffff) refuse("A zip archive of this kind (64-bit) is not supported.");
    if (count > sink.limits.entries) refuse("The archive has too many files.");
    const cd = read(cdAt, cdSize);
    let at = 0;
    for (let n = 0; n < count; n++) {
      if (at + 46 > cd.length || cd.readUInt32LE(at) !== 0x02014b50) refuse("The archive is damaged: its list of files cannot be read.");
      const flags = cd.readUInt16LE(at + 8), method = cd.readUInt16LE(at + 10), csize = cd.readUInt32LE(at + 20), usize = cd.readUInt32LE(at + 24);
      const nameLen = cd.readUInt16LE(at + 28), extraLen = cd.readUInt16LE(at + 30), commentLen = cd.readUInt16LE(at + 32), attr = cd.readUInt32LE(at + 38), local = cd.readUInt32LE(at + 42);
      const name = cd.subarray(at + 46, at + 46 + nameLen).toString("utf8");
      at += 46 + nameLen + extraLen + commentLen;
      const unix = (attr >>> 16) & 0o177777;
      const kind = unix & 0o170000;
      if (kind === 0o120000) refuse("The archive has a link, which a zip archive is not allowed to have here.");
      if (kind && kind !== 0o100000 && kind !== 0o040000) refuse("The archive has an entry of a kind that is not allowed.");
      const rel = cleanName(name, sink.limits.depth);
      if (name.endsWith("/")) { sink.dir(rel); continue; }
      if (!rel) refuse("The archive has a file with no name.");
      if (flags & 1) refuse("The archive is encrypted.");
      if (usize > sink.limits.entryBytes) refuse("A file in the archive is larger than is allowed.");
      const lh = read(local, 30);
      if (lh.readUInt32LE(0) !== 0x04034b50) refuse("The archive is damaged: a file cannot be found.");
      const data = read(local + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28), csize);
      let body: Buffer;
      if (method === 0) body = data;
      else if (method === 8) { try { body = inflateRawSync(data, { maxOutputLength: usize + 1 }); } catch { return refuse("The archive is damaged or larger than it says."); } } else return refuse("The archive uses a way of packing that is not supported.");
      if (body.length !== usize) refuse("The archive is damaged: a file is not the size it says.");
      const out = sink.open(rel, (unix & 0o111) !== 0);
      try { out.write(body); } finally { out.close(); }
    }
  } finally { closeSync(fd); }
}

/** Takes `file` apart into `dest`, a folder that is new and empty (the caller makes it). Anything wrong stops it with an `ArchiveError`; what was made is the caller's to remove. */
export async function extractArchive(file: string, dest: string, kind: "tar.gz" | "zip", limits: Limits = LIMITS): Promise<void> {
  mkdirSync(dest, { recursive: true, mode: 0o700 });
  const sink = new Sink(dest, limits);
  if (kind === "zip") { try { unzip(file, sink); } catch (e) { throw e instanceof ArchiveError ? e : new ArchiveError("The archive is damaged: it could not be unpacked."); } }
  else {
    const gz = createGunzip();
    const src = createReadStream(file);
    src.on("error", (e) => { gz.destroy(e); });
    src.pipe(gz);
    try { await untar(gz as unknown as AsyncIterable<Buffer>, sink); } catch (e) {
      if (e instanceof ArchiveError) throw e;
      throw new ArchiveError("The archive is damaged: it could not be unpacked.");
    } finally { src.destroy(); gz.destroy(); }
  }
  sink.verify();
}

