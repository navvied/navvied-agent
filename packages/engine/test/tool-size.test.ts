import { afterAll, describe, expect, test } from "bun:test";
import { defaultTools } from "../src/index.ts";
import { cleanupAll, prompt, rig } from "./helpers.ts";

afterAll(cleanupAll);

describe("the weight of the tools a small model is shown", () => {
  test("Bash, the one tool always offered, takes at most 600 characters", () => {
    const bash = defaultTools().find((t) => t.name === "Bash")!;
    expect(JSON.stringify({ description: bash.description, parameters: bash.parameters }).length).toBeLessThanOrEqual(600);
  });

  test("the tools of a first request take at most 3,000 characters in all", async () => {
    const r = rig(() => ({ text: "ok" }));
    await r.turn(prompt("hello"));
    expect(JSON.stringify(r.provider.requests[0]!.tools).length).toBeLessThanOrEqual(3000);
    r.cleanup();
  });
});
