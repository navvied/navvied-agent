import { expect, test } from "bun:test";
import { deepMerge } from "../src/merge.ts";

test("b wins on plain values", () => expect(deepMerge({ x: 1, y: 2 }, { y: 3 })).toEqual({ x: 1, y: 3 }));
test("objects merge recursively", () => expect(deepMerge({ a: { b: 1, c: 2 } }, { a: { c: 3, d: 4 } })).toEqual({ a: { b: 1, c: 3, d: 4 } }));
test("arrays are replaced, not merged", () => expect(deepMerge({ l: [1, 2, 3] }, { l: [9] })).toEqual({ l: [9] }));
test("does not modify its inputs", () => {
  const a = { n: { v: 1 } }; const b = { n: { w: 2 } };
  deepMerge(a, b);
  expect(a).toEqual({ n: { v: 1 } }); expect(b).toEqual({ n: { w: 2 } });
});
test("null replaces an object", () => expect(deepMerge({ a: { b: 1 } }, { a: null })).toEqual({ a: null }));
