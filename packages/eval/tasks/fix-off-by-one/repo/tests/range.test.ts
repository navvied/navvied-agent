import { expect, test } from "bun:test";
import { range } from "../src/range.ts";

test("includes both ends", () => expect(range(1, 4)).toEqual([1, 2, 3, 4]));
test("a single value", () => expect(range(5, 5)).toEqual([5]));
test("empty when start is after end", () => expect(range(3, 1)).toEqual([]));
