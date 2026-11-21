import { afterAll, describe, expect, test } from "bun:test";
import { HOOK_MS, cleanupAll, prompt, rig } from "./helpers.ts";

afterAll(cleanupAll, HOOK_MS);

describe("a step is timed by the engine's own clock", () => {
  test("the event that ends a step says when the engine began it and how long it ran, so a page needs nothing of its own to time it", async () => {
    const r = rig((req) => (req.messages.at(-1)?.role === "tool" ? { text: "done" } : { calls: [{ name: "Bash", args: { command: "echo hi" } }] }));
    const before = Date.now();
    await r.turn(prompt("say hi", { mode: "auto" }));
    const end = r.of("tool").find((e) => e.status === "done")!;
    expect(end.startedAt).toBeGreaterThanOrEqual(before);
    expect(end.ms).toBeGreaterThanOrEqual(0);
    expect(end.startedAt! + end.ms!).toBeLessThanOrEqual(Date.now());
    expect(r.of("tool").filter((e) => e.status === "running").some((e) => e.startedAt !== undefined)).toBe(false);
    r.cleanup();
  });
});
