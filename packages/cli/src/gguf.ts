/** What the memory a model needs depends on, read from the start of a GGUF file (the format is the one of ggml's docs/gguf.md, version 2 or 3, little-endian). */
export interface ModelShape {
  architecture: string;
  layers: number;
  /** The number of heads of keys and values that are kept for each layer (one number per layer: it may differ between layers). */
  kvHeads: number[];
  keyLength: number;
  valueLength: number;
  /** The context the model was made for. */
  contextLength?: number;
}

export type ShapeResult = { shape: ModelShape } | { more: true } | { error: string };

const TYPE_SIZE: Record<number, number> = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };
const STRING = 8, ARRAY = 9;

class Short extends Error {}

class Reader {
  at = 0;
  readonly view: DataView;
  constructor(readonly bytes: Uint8Array) { this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); }
  need(n: number): void { if (this.at + n > this.bytes.length) throw new Short(); }
  u32(): number { this.need(4); const v = this.view.getUint32(this.at, true); this.at += 4; return v; }
  u64(): number { this.need(8); const v = this.view.getBigUint64(this.at, true); this.at += 8; if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("a length that is too large"); return Number(v); }
  skip(n: number): void { this.need(n); this.at += n; }
  string(): string { const len = this.u64(); if (len > 1 << 20) throw new Error("a string that is too long"); this.need(len); const s = new TextDecoder().decode(this.bytes.subarray(this.at, this.at + len)); this.at += len; return s; }
  skipString(): void { const len = this.u64(); this.skip(len); }
  number(type: number): number | undefined {
    this.need(TYPE_SIZE[type] ?? 0);
    const v = this.view;
    const n = type === 0 ? v.getUint8(this.at) : type === 1 ? v.getInt8(this.at) : type === 2 ? v.getUint16(this.at, true) : type === 3 ? v.getInt16(this.at, true) : type === 4 ? v.getUint32(this.at, true) : type === 5 ? v.getInt32(this.at, true) : type === 6 ? v.getFloat32(this.at, true) : type === 10 ? Number(v.getBigUint64(this.at, true)) : type === 11 ? Number(v.getBigInt64(this.at, true)) : type === 12 ? v.getFloat64(this.at, true) : undefined;
    this.at += TYPE_SIZE[type]!;
    return n;
  }
}

/** One value: a number, a string, a list of numbers (kept only when short enough to matter), or skipped. */
function value(r: Reader, type: number, keep: boolean): number | string | number[] | undefined {
  if (type === STRING) { if (keep) return r.string(); r.skipString(); return undefined; }
  if (type === ARRAY) {
    const inner = r.u32();
    const len = r.u64();
    if (inner === STRING) { for (let i = 0; i < len; i++) r.skipString(); return undefined; }
    const size = TYPE_SIZE[inner];
    if (size === undefined) throw new Error("a kind of value that is not known");
    if (!keep || len > 4096) { r.skip(len * size); return undefined; }
    const out: number[] = [];
    for (let i = 0; i < len; i++) out.push(r.number(inner)!);
    return out;
  }
  if (TYPE_SIZE[type] === undefined) throw new Error("a kind of value that is not known");
  return r.number(type);
}

/**
 * The shape of the model from the first bytes of its file. `more` says the bytes end before every key that is needed was seen (the keys of the model come before the
 * long ones of the tokenizer, and reading stops at the first of those, so a few hundred kilobytes are usually enough): ask for more of the file and try again. No guess: a model that does not say a number has none.
 */
export function readShape(bytes: Uint8Array): ShapeResult {
  const r = new Reader(bytes);
  try {
    if (bytes.length < 4) return { more: true };
    if (r.u32() !== 0x46554747) return { error: "This file is not a GGUF file." };
    const version = r.u32();
    if (version !== 2 && version !== 3) return { error: `A GGUF version that is not read (${version}).` };
    r.u64();
    const count = r.u64();
    const found = new Map<string, number | string | number[]>();
    let architecture: string | undefined;
    const wanted = (key: string): boolean => key === "general.architecture" || (architecture !== undefined && key.startsWith(`${architecture}.`) && /\.(block_count|context_length|embedding_length|attention\.(head_count|head_count_kv|key_length|value_length))$/.test(key));
    for (let i = 0; i < count; i++) {
      const key = r.string();
      // The tokenizer's keys come after the model's own and are the long ones: what the shape needs has been said by then.
      if (key.startsWith("tokenizer.")) break;
      const type = r.u32();
      const keep = wanted(key);
      const v = value(r, type, keep);
      if (keep && v !== undefined) { found.set(key, v); if (key === "general.architecture" && typeof v === "string") architecture = v; }
    }
    if (!architecture) return { error: "The file does not say what kind of model it is." };
    const get = (k: string): number | number[] | undefined => { const v = found.get(`${architecture}.${k}`); return typeof v === "string" ? undefined : v; };
    const layersRaw = get("block_count");
    const layers = typeof layersRaw === "number" ? layersRaw : undefined;
    const heads = get("attention.head_count");
    const headCount = typeof heads === "number" ? heads : undefined;
    const embedding = get("embedding_length");
    const embed = typeof embedding === "number" ? embedding : undefined;
    if (!layers || !headCount || !embed) return { error: "The file does not say its number of layers, heads or its size." };
    const kv = get("attention.head_count_kv");
    const kvHeads = Array.isArray(kv) ? kv : Array(layers).fill(typeof kv === "number" && kv > 0 ? kv : headCount);
    const keyLen = get("attention.key_length"), valLen = get("attention.value_length");
    const keyLength = typeof keyLen === "number" ? keyLen : Math.floor(embed / headCount);
    const valueLength = typeof valLen === "number" ? valLen : Math.floor(embed / headCount);
    const ctx = get("context_length");
    return { shape: { architecture, layers, kvHeads, keyLength, valueLength, ...(typeof ctx === "number" ? { contextLength: ctx } : {}) } };
  } catch (e) {
    if (e instanceof Short) return { more: true };
    return { error: `The file could not be read (${e instanceof Error ? e.message : "unknown"}).` };
  }
}
