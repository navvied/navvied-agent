/** A GGUF header made by hand, in the layout of the format's own document: enough to test the reading without any model. */
const enc = new TextEncoder();
const u32 = (n: number): number[] => [...new Uint8Array(new Uint32Array([n]).buffer)];
const u64 = (n: number): number[] => [...new Uint8Array(new BigUint64Array([BigInt(n)]).buffer)];
const str = (s: string): number[] => [...u64(enc.encode(s).length), ...enc.encode(s)];

export type Value = { t: "u32" | "u64" | "str" | "f32"; v: number | string } | { t: "arr"; of: "u32"; v: number[] } | { t: "strs"; v: string[] };

const value = (x: Value): number[] =>
  x.t === "u32" ? [...u32(4), ...u32(x.v as number)]
  : x.t === "u64" ? [...u32(10), ...u64(x.v as number)]
  : x.t === "f32" ? [...u32(6), ...new Uint8Array(new Float32Array([x.v as number]).buffer)]
  : x.t === "str" ? [...u32(8), ...str(x.v as string)]
  : x.t === "arr" ? [...u32(9), ...u32(4), ...u64((x.v as number[]).length), ...(x.v as number[]).flatMap((n) => u32(n))]
  : [...u32(9), ...u32(8), ...u64((x.v as string[]).length), ...(x.v as string[]).flatMap(str)];

export function gguf(kvs: [string, Value][], version = 3): Uint8Array {
  return new Uint8Array([...u32(0x46554747), ...u32(version), ...u64(0), ...u64(kvs.length), ...kvs.flatMap(([k, v]) => [...str(k), ...value(v)])]);
}

/** The keys of a model of the usual kind (llama-like), then the long tokenizer ones. */
export function llama(o: { layers?: number; heads?: number; kvHeads?: number | number[]; embed?: number; context?: number; keyLength?: number; tokens?: number; template?: string } = {}): Uint8Array {
  const layers = o.layers ?? 32, heads = o.heads ?? 32;
  const kv: [string, Value][] = [
    ["general.architecture", { t: "str", v: "llama" }],
    ["general.name", { t: "str", v: "Test" }],
    ["llama.context_length", { t: "u32", v: o.context ?? 131072 }],
    ["llama.embedding_length", { t: "u32", v: o.embed ?? 4096 }],
    ["llama.block_count", { t: "u32", v: layers }],
    ["llama.attention.head_count", { t: "u32", v: heads }],
    ...(o.kvHeads === undefined ? [["llama.attention.head_count_kv", { t: "u32", v: 8 }] as [string, Value]] : Array.isArray(o.kvHeads) ? [["llama.attention.head_count_kv", { t: "arr", of: "u32", v: o.kvHeads } as Value] as [string, Value]] : [["llama.attention.head_count_kv", { t: "u32", v: o.kvHeads }] as [string, Value]]),
    ...(o.keyLength ? ([["llama.attention.key_length", { t: "u32", v: o.keyLength }], ["llama.attention.value_length", { t: "u32", v: o.keyLength }]] as [string, Value][]) : []),
    ["tokenizer.ggml.model", { t: "str", v: "gpt2" }],
    ["tokenizer.ggml.tokens", { t: "strs", v: Array.from({ length: o.tokens ?? 50 }, (_, i) => `tok${i}`) }],
    ...(o.template !== undefined ? ([["tokenizer.chat_template", { t: "str", v: o.template }]] as [string, Value][]) : []),
  ];
  return gguf(kv);
}
