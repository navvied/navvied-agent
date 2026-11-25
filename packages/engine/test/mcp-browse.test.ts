import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { connectMcp } from "../src/index.ts";
import { rig, cleanupAll, until } from "./helpers.ts";
import { stopAllJobs } from "../src/index.ts";
import { HOOK_MS, hook } from "../../protocol/test/support/cleanup.ts";

const FAKE = join(import.meta.dir, "fake-mcp.js");
afterAll(hook("mcp browse removes what it made", async () => { await stopAllJobs(); await cleanupAll(); }), HOOK_MS);
const server = (mode: string) => ({ command: process.execPath, args: [FAKE], env: { FAKE_MODE: mode } });
const signal = new AbortController().signal;

describe("what a page may ask of the connected programs", () => {
  test("the documents of the programs that have any, with the program of each; one that has none is not asked", async () => {
    const mcp = await connectMcp({ docs: server("rich"), plain: server("") });
    try {
      const all = await mcp.resources();
      expect(all.problems).toEqual([]);
      expect(all.items).toEqual([
        { server: "docs", uri: "note://a", name: "Note A", description: "The first note", mimeType: "text/plain" },
        { server: "docs", uri: "img://logo", name: "Logo", mimeType: "image/png" },
        { server: "docs", uri: "note://{id}", name: "Any note", template: true },
      ]);
      expect((await mcp.resources("plain")).items).toEqual([]);
    } finally { mcp.close(); }
  });

  test("a document is read as parts: text as text, a picture as base64, and a wrong address is an error", async () => {
    const mcp = await connectMcp({ docs: server("rich") });
    try {
      expect(await mcp.readResource("docs", "note://a", signal)).toEqual([{ uri: "note://a", mime: "text/plain", bytes: 8, text: "Buy milk" }]);
      expect(await mcp.readResource("docs", "img://logo", signal)).toEqual([{ mime: "image/png", bytes: 1, data: "AA==" }]);
      await expect(mcp.readResource("docs", "note://zzz", signal)).rejects.toThrow("no resource");
      await expect(mcp.readResource("other", "note://a", signal)).rejects.toThrow("has no documents");
    } finally { mcp.close(); }
  });

  test("tools by words are the same search the model has, and a page's search offers nothing to the model", async () => {
    const mcp = await connectMcp({ docs: server("rich") });
    try {
      const hit = mcp.find("add numbers");
      expect(hit.total).toBe(7);
      expect(hit.items[0]).toEqual({ server: "docs", name: "mcp__docs__add_numbers", tool: "add numbers", description: "Add two numbers", signature: "mcp__docs__add_numbers(a?: number, b?: number)" });
      expect(mcp.find("zzzzz").items).toEqual([]);
      // Without words: the first tools by name, of one program when asked.
      expect(mcp.find().items.map((t) => t.tool)).toEqual(["add numbers", "big", "echo", "fail", "inject", "picture", "slow"]);
      expect(mcp.find(undefined, "nope").total).toBe(0);
      // Nothing was made callable: the tools are all listed already (not too many to list), and the search tool is not there.
      expect(mcp.tools.some((t) => t.name === "mcp__find")).toBe(false);
    } finally { mcp.close(); }
  });

  test("the engine answers mcp.resources, mcp.resource and mcp.tools as events", async () => {
    const r = rig(() => ({ text: "x" }));
    r.engine.loadTools(connectMcp({ docs: server("rich") }));
    r.send({ cmd: "mcp.resources" });
    await until(() => r.of("mcp.resources").length > 0);
    expect(r.of("mcp.resources")[0]!.items.map((i) => i.uri)).toEqual(["note://a", "img://logo", "note://{id}"]);
    r.send({ cmd: "mcp.resource", server: "docs", uri: "note://a" });
    await until(() => r.of("mcp.resource").length > 0);
    expect(r.of("mcp.resource")[0]).toMatchObject({ server: "docs", uri: "note://a", contents: [{ text: "Buy milk" }] });
    r.send({ cmd: "mcp.resource", server: "docs", uri: "note://zzz" });
    await until(() => r.of("error").length > 0);
    expect(r.of("error")[0]!.msg).toContain("The document could not be read");
    r.send({ cmd: "mcp.tools", query: "echo" });
    await until(() => r.of("mcp.tools").length > 0);
    expect(r.of("mcp.tools")[0]).toMatchObject({ query: "echo", total: 7, items: [{ tool: "echo" }] });
    r.cleanup();
  });
});
