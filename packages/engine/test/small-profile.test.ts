import { afterAll, describe, expect, test } from "bun:test";
import { SMALL_WINDOW } from "../src/index.ts";
import { cleanupAll, prompt, rig } from "./helpers.ts";

afterAll(async () => { await cleanupAll(); });

/** The first request a small local model gets: the system text and the tool definitions, in characters. */
const firstRequest = async (userText: string) => {
  const r = rig(() => ({ text: "ok" }), { window: SMALL_WINDOW });
  await r.turn(prompt(userText));
  const first = r.provider.requests[0]!;
  return { names: first.tools.map((t) => t.name), chars: first.system.length + JSON.stringify(first.tools).length };
};

describe("the small-model profile", () => {
  test("the first request stays within 3,000 characters plus the question tool, and offers only the tools of the work", async () => {
    const { names, chars } = await firstRequest("fix the failing test in this folder");
    expect(chars).toBeLessThanOrEqual(3_500);
    expect(names).toEqual(expect.arrayContaining(["Read", "Edit", "Bash", "AskUserQuestion"]));
    expect(names.length).toBeLessThanOrEqual(8);
    for (const heavy of ["Agent", "SkillManage", "NotebookEdit", "MultiEdit", "apply_patch"]) expect(names).not.toContain(heavy);
  });
});
