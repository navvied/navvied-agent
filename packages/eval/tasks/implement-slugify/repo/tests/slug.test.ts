import { expect, test } from "bun:test";
import { slugify } from "../src/slug.ts";

test("lowercases and joins words with dashes", () => expect(slugify("Hello World")).toBe("hello-world"));
test("drops punctuation", () => expect(slugify("Rock & Roll, Baby!")).toBe("rock-roll-baby"));
test("collapses repeated separators", () => expect(slugify("a   --  b")).toBe("a-b"));
test("trims separators at the ends", () => expect(slugify("  --Title--  ")).toBe("title"));
test("folds accents", () => expect(slugify("Crème Brûlée")).toBe("creme-brulee"));
test("empty input stays empty", () => expect(slugify("")).toBe(""));
