import { expect, test } from "bun:test";
import { loadAll } from "../src/load.ts";

test("resolves every item", async () => {
  expect(await loadAll([1, 2])).toEqual([{ id: 1, name: "item-1" }, { id: 2, name: "item-2" }]);
});
test("an empty list", async () => expect(await loadAll([])).toEqual([]));
