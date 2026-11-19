import { expect, test } from "bun:test";
import { sortDescending } from "../src/sort.ts";

test("numeric order", () => expect(sortDescending([2, 10, 1, 33])).toEqual([33, 10, 2, 1]));
test("negative numbers", () => expect(sortDescending([-1, -10, 5])).toEqual([5, -1, -10]));
test("does not modify the input", () => { const v = [1, 3, 2]; sortDescending(v); expect(v).toEqual([1, 3, 2]); });
