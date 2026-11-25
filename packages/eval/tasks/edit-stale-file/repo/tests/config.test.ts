import { expect, test } from "bun:test";
import { label, retries, timeoutMs } from "../src/config.ts";

test("retries is 5", () => expect(retries).toBe(5));
test("the other process's timeout is kept", () => expect(timeoutMs).toBe(2000));
test("the label is untouched", () => expect(label).toBe("service"));
