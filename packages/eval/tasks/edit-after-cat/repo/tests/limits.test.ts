import { expect, test } from "bun:test";
import { limit, name } from "../src/limits.ts";

test("the limit is 50", () => expect(limit).toBe(50));
test("the name is kept", () => expect(name).toBe("queue"));
