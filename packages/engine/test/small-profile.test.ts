import { afterAll, describe, expect, test } from "bun:test";
import { SMALL_WINDOW } from "../src/index.ts";
import { outputBudget } from "../src/tools/util.ts";
import { cleanupAll, prompt, rig } from "./helpers.ts";

afterAll(async () => { await cleanupAll(); });

/** The first request a small local model gets: the system text and the tool definitions, in characters. */
const firstRequest = async (userText: string) => {
  const r = rig(() => ({ text: "ok" }), { window: SMALL_WINDOW, small: true });
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

  test("a short window is not a small model: at 32,000 tokens a model that is not marked small gets the same tools as one with a large window, with shorter results", async () => {
    const ask = "fix the login bug, add a test for it, update the changelog";
    const offered = async (window: number): Promise<string[]> => {
      const r = rig(() => ({ text: "ok" }), { window });
      await r.turn(prompt(ask));
      r.cleanup();
      return r.provider.requests[0]!.tools.map((t) => t.name);
    };
    const short = await offered(32_000);
    expect(short).toEqual(await offered(1_000_000));
    for (const t of ["Agent", "TodoWrite"]) expect(short).toContain(t);
    expect(outputBudget(32_000)).toBeLessThan(outputBudget(1_000_000));
  });

  test("the small flag follows the model when it is switched, not the window", async () => {
    const small = rig(() => ({ text: "ok" }), { window: 100_000, small: true });
    await small.turn(prompt("fix the failing test in this folder"));
    expect(small.provider.requests[0]!.tools.map((t) => t.name)).not.toContain("Agent");
    small.cleanup();
  });
});
