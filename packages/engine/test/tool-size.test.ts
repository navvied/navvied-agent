import { afterAll, describe, expect, test } from "bun:test";
import { defaultTools } from "../src/index.ts";
import { HOOK_MS, cleanupAll, prompt, rig } from "./helpers.ts";

afterAll(cleanupAll, HOOK_MS);

describe("the weight of the tools a small model is shown", () => {
  test("Bash, the one tool always offered, takes at most 600 characters", () => {
    const bash = defaultTools().find((t) => t.name === "Bash")!;
    expect(JSON.stringify({ description: bash.description, parameters: bash.parameters }).length).toBeLessThanOrEqual(600);
  });

  test("Browser, which a request that needs a real browser is offered with its whole text, takes at most 1,400 characters (it took 1,137 before hover, drag, fill, frames and places in a screenshot)", () => {
    const browser = defaultTools().find((t) => t.name === "Browser")!;
    expect(browser.description.length + JSON.stringify(browser.parameters).length).toBeLessThanOrEqual(1400);
  });

  test("the tools of a first request take at most 3,000 characters in all", async () => {
    const r = rig(() => ({ text: "ok" }));
    await r.turn(prompt("hello"));
    expect(JSON.stringify(r.provider.requests[0]!.tools).length).toBeLessThanOrEqual(3000);
    r.cleanup();
  });
});
