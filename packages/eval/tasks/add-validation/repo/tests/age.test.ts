import { expect, test } from "bun:test";
import { parseAge } from "../src/age.ts";

test("a valid age", () => expect(parseAge("42")).toBe(42));
test("the bounds are valid", () => { expect(parseAge("0")).toBe(0); expect(parseAge("150")).toBe(150); });
test("out of range", () => { expect(() => parseAge("-1")).toThrow(RangeError); expect(() => parseAge("151")).toThrow(RangeError); });
test("not a whole number", () => { for (const bad of ["abc", "4.5", "", " ", "1e2"]) expect(() => parseAge(bad)).toThrow(TypeError); });
