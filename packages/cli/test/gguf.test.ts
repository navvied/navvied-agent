import { describe, expect, test } from "bun:test";
import { readShape, readTemplate, templateTakesTools } from "../src/gguf.ts";
import { gguf, llama } from "./gguf-builder.ts";

describe("the shape of a model from the start of its file", () => {
  test("layers, the heads that are kept, the size of a head and what the model was made for", () => {
    expect(readShape(llama())).toEqual({ shape: { architecture: "llama", layers: 32, kvHeads: Array(32).fill(8), keyLength: 128, valueLength: 128, contextLength: 131072 } });
  });

  test("a model that says how long a head is (not the size divided by the heads), and one that keeps a different number of heads in each layer", () => {
    const r = readShape(llama({ layers: 4, kvHeads: [1, 2, 4, 8], keyLength: 256 }));
    expect(r).toMatchObject({ shape: { layers: 4, kvHeads: [1, 2, 4, 8], keyLength: 256, valueLength: 256 } });
  });

  test("a model that does not say the heads it keeps keeps them all", () => {
    const bytes = gguf([["general.architecture", { t: "str", v: "falcon" }], ["falcon.block_count", { t: "u32", v: 2 }], ["falcon.attention.head_count", { t: "u32", v: 16 }], ["falcon.embedding_length", { t: "u32", v: 1024 }]]);
    expect(readShape(bytes)).toEqual({ shape: { architecture: "falcon", layers: 2, kvHeads: [16, 16], keyLength: 64, valueLength: 64 } });
  });

  test("a long tokenizer after the model's keys is not read, so a short start of the file is enough", () => {
    const whole = llama({ tokens: 200_000 });
    expect(whole.length).toBeGreaterThan(1_000_000);
    const start = whole.slice(0, 600);
    expect(readShape(start)).toMatchObject({ shape: { layers: 32 } });
  });

  test("the bytes end before the keys do: more is asked for, and nothing is made up", () => {
    expect(readShape(llama().slice(0, 100))).toEqual({ more: true });
    expect(readShape(llama().slice(0, 3))).toEqual({ more: true });
  });

  test("a file that is not GGUF, a version that is not read, and a model that does not say its layers each say so", () => {
    expect(readShape(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]))).toEqual({ error: "This file is not a GGUF file." });
    expect(readShape(gguf([], 1))).toEqual({ error: "A GGUF version that is not read (1)." });
    expect(readShape(gguf([["general.architecture", { t: "str", v: "llama" }]]))).toEqual({ error: "The file does not say its number of layers, heads or its size." });
    expect(readShape(gguf([["general.name", { t: "str", v: "x" }]]))).toEqual({ error: "The file does not say what kind of model it is." });
  });
});

describe("whether a model handles tools, from the chat template inside its file", () => {
  const withTools = "{%- if tools %}{{ tools }}{%- endif %}{% for m in messages %}{{ m.content }}{% endfor %}";
  const without = "{% for m in messages %}{{ m.content }}{% endfor %}";

  test("the template comes after the long lists of the tokenizer, and is read from there", () => {
    expect(readTemplate(llama({ template: withTools, tokens: 5000 }))).toEqual({ template: withTools });
    expect(readTemplate(llama())).toEqual({ template: undefined });
  });

  test("a file that ends before it says to ask for more, and a file that is not a model says so", () => {
    const bytes = llama({ template: withTools, tokens: 5000 });
    expect(readTemplate(bytes.subarray(0, 3000))).toEqual({ more: true });
    expect(readTemplate(new Uint8Array(40))).toEqual({ error: "This file is not a GGUF file." });
  });

  test("a template that names tools handles them; one that does not, does not; none says nothing", () => {
    expect(templateTakesTools(withTools)).toBe(true);
    expect(templateTakesTools(without)).toBe(false);
    expect(templateTakesTools("   ")).toBeUndefined();
    expect(templateTakesTools(undefined)).toBeUndefined();
  });
});
