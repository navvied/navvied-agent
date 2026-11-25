import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { double, triple } from "../src/index.ts";

test("double", () => expect(double(4)).toBe(8));
test("triple", () => expect(triple(3)).toBe(9));
test("the files are where they should be", () => {
  expect(existsSync("src/helpers.ts")).toBe(true);
  expect(existsSync("src/utils.ts")).toBe(false);
  expect(existsSync("src/legacy.ts")).toBe(false);
});
