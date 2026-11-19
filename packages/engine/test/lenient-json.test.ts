import { describe, expect, test } from "bun:test";
import { parseLenient } from "../src/lenient-json.ts";

describe("reading tool arguments that are almost JSON", () => {
  test("proper JSON, and an empty string, are taken as they are", () => {
    expect(parseLenient('{"path":"a.ts","limit":10}')).toEqual({ path: "a.ts", limit: 10 });
    expect(parseLenient("  ")).toEqual({});
    expect(parseLenient("{}")).toEqual({});
  });

  test.each([
    ["a code fence", '```json\n{"path":"a.ts"}\n```', { path: "a.ts" }],
    ["text around it", 'Sure! {"path":"a.ts"} Let me know.', { path: "a.ts" }],
    ["a trailing comma", '{"path":"a.ts",}', { path: "a.ts" }],
    ["single quotes", "{'path':'a.ts'}", { path: "a.ts" }],
    ["bare keys", '{path:"a.ts", limit: 5}', { path: "a.ts", limit: 5 }],
    ["Python values", '{"all":True,"none":None,"off":False}', { all: true, none: null, off: false }],
    ["a missing closing brace", '{"path":"a.ts"', { path: "a.ts" }],
    ["missing closers and an open string", '{"path":"a.ts","note":"half', { path: "a.ts", note: "half" }],
    ["a nested object left open", '{"a":{"b":[1,2', { a: { b: [1, 2] } }],
    ["a raw line break inside a string", '{"content":"line one\nline two\tend"}', { content: "line one\nline two\tend" }],
    ["several slips at once", "```\n{path: 'a.ts', all: True,\n```", { path: "a.ts", all: true }],
  ])("%s", (_name, text, expected) => {
    expect(parseLenient(text as string)).toEqual(expected);
  });

  test("quoted text that looks like a slip is left alone", () => {
    expect(parseLenient('{"content":"it\'s {fine}, True, x: 1,}"}')).toEqual({ content: "it's {fine}, True, x: 1,}" });
    expect(parseLenient('{"a":"b"')).toEqual({ a: "b" });
  });

  test("what cannot be rescued gives nothing, never a guess", () => {
    expect(parseLenient("read the file please")).toBeUndefined();
    expect(parseLenient("[1,2,3]")).toBeUndefined();
    expect(parseLenient('"just a string"')).toBeUndefined();
    expect(parseLenient("{{{")).toBeUndefined();
  });

  test("it never throws and always returns an object or nothing, whatever it is given", () => {
    let seed = 11;
    const next = (): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed; };
    const pieces = ["{", "}", "[", "]", '"', "'", ",", ":", "\\", "a", "true", "None", " ", "\n", "key", "1", "{\"a\":1}"];
    for (let n = 0; n < 2000; n++) {
      const text = Array.from({ length: next() % 14 }, () => pieces[next() % pieces.length]!).join("");
      const out = parseLenient(text);
      expect(out === undefined || (typeof out === "object" && out !== null && !Array.isArray(out))).toBe(true);
    }
  });
});
