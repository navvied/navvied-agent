import { expect, test } from "bun:test";
import { sizes } from "../src/sizes.ts";

test("small is 12", () => expect(sizes.small).toBe(12));
test("the others are kept", () => expect([sizes.medium, sizes.large]).toEqual([16, 24]));
