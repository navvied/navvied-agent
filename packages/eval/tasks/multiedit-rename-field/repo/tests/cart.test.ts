import { expect, test } from "bun:test";
import { add, count, total } from "../src/cart.ts";

const lines = add(add([], "a", 2, 5), "b", 1, 10);

test("the field is called quantity", () => expect(lines[0]).toEqual({ sku: "a", quantity: 2, unit: 5 }));
test("total", () => expect(total(lines)).toBe(20));
test("count", () => expect(count(lines)).toBe(3));
