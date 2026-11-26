import { afterAll, describe, expect, test } from "bun:test";
import { defaultTools } from "../src/index.ts";
import { HOOK_MS, cleanupAll, prompt, rig } from "./helpers.ts";

afterAll(cleanupAll, HOOK_MS);

describe("the weight of the tools", () => {
  test("Bash, the one tool always offered, takes at most 600 characters", () => {
    const bash = defaultTools().find((t) => t.name === "Bash")!;
    expect(JSON.stringify({ description: bash.description, parameters: bash.parameters }).length).toBeLessThanOrEqual(600);
  });

  test("Browser, which a request that needs a real browser is offered with its whole text, takes at most 1,400 characters (it took 1,137 before hover, drag, fill, frames and places in a screenshot)", () => {
    const browser = defaultTools().find((t) => t.name === "Browser")!;
    expect(browser.description.length + JSON.stringify(browser.parameters).length).toBeLessThanOrEqual(1400);
  });

  test("the tools of a small model's first request take at most 2,600 characters and are at most 8", async () => {
    const r = rig(() => ({ text: "ok" }), { window: 8_000, small: true });
    await r.turn(prompt("hello"));
    expect(JSON.stringify(r.provider.requests[0]!.tools).length).toBeLessThanOrEqual(2600);
    expect(r.provider.requests[0]!.tools.length).toBeLessThanOrEqual(8);
    r.cleanup();
  });

  // A model that is not small is shown every tool that is set up for it: 6,379 characters and 15 tools in this rig (no schedule, skills or memory), 4,148 and 11 before.
  test("the tools of a first request of a model that is not small take at most 9,000 characters and are at most 24", async () => {
    const r = rig(() => ({ text: "ok" }));
    await r.turn(prompt("hello"));
    expect(JSON.stringify(r.provider.requests[0]!.tools).length).toBeLessThanOrEqual(9000);
    expect(r.provider.requests[0]!.tools.length).toBeLessThanOrEqual(24);
    r.cleanup();
  });
});
