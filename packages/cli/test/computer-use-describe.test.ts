import { expect, test } from "bun:test";
import { describeTools } from "../src/computer-use/describe.ts";

test("a tool is one line: its properties with their shapes, the required ones starred", () => {
  const out = describeTools([
    { name: "click", inputSchema: { properties: { pid: { type: "integer" }, mode: { enum: ["a", "b"] }, x: { type: ["number", "null"] } }, required: ["pid"] } as never },
    { name: "list_apps" },
  ]);
  expect(out).toBe("click(pid*:integer, mode:a|b, x:number|null)\nlist_apps()");
});
