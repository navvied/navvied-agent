import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { HOOK_MS, cleanupAll, prompt, rig } from "./helpers.ts";
import { pages } from "../src/tools/web-cache.ts";

afterAll(cleanupAll, HOOK_MS);
beforeEach(() => pages.clear());

const site = Bun.serve({ port: 0, fetch: () => new Response("<html><head><title>Docs</title></head><body><main><p>The release code is in this page.</p></main></body></html>", { headers: { "content-type": "text/html" } }) });
afterAll(() => site.stop(true));

describe("a step that was answered from what was read lately says so", () => {
  test("WebFetch of a page read a moment ago carries cached: true, the first visit does not, and no other step does", async () => {
    const url = `http://127.0.0.1:${site.port}/docs`;
    const r = rig((req) => {
      const calls = req.messages.filter((m) => m.role === "tool").length;
      return calls < 2 ? { calls: [{ name: "WebFetch", args: { url } }] } : { text: "done" };
    }, { allowPrivateNetwork: true });
    await r.turn(prompt(`read ${url} twice`, { mode: "auto" }));
    const ended = r.of("tool").filter((e) => e.status === "done" || e.status === "error");
    expect(ended.map((e) => e.name)).toEqual(["WebFetch", "WebFetch"]);
    expect(ended[0]).not.toHaveProperty("cached");
    expect(ended[1]).toMatchObject({ status: "done", cached: true });
    r.cleanup();
  });
});
