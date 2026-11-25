import { describe, expect, test } from "bun:test";
import { SLASH_COMMANDS } from "../src/slash.ts";
import { PERSON_ONLY, soulFor } from "../src/soul.ts";

const words = (s: string): number => s.split(/\s+/).length;

describe("what every brain is told about navvied", () => {
  test("it is navvied, the model is its brain, and no other product is named", () => {
    const text = soulFor({ label: '"raphael"' });
    expect(text).toContain("You are navvied");
    expect(text).toContain('"raphael"');
    expect(text).toContain("not your name");
    expect(text).not.toContain("standing instructions for this work");
  });
  test("it knows the real commands, so it can answer how to switch the model", () => {
    const text = soulFor({ label: "x" });
    for (const c of SLASH_COMMANDS.filter((c) => !PERSON_ONLY.has(c.name))) expect(text).toContain(`/${c.name}`);
    expect(text).toContain("/model (choose or switch the model)");
    expect(text).toContain("Shift+Tab");
    expect(text).toContain("NAVVIED.md");
  });
  test("it lists the engine's own tools, and none when a program brings its own", () => {
    expect(soulFor({ label: "x", tools: ["Read", "Write"] })).toContain("Your tools: Read, Write.");
    expect(soulFor({ label: "x" })).not.toContain("Your tools");
  });
  test("a program's brain is told that its tools are the program's, not navvied's", () => {
    const text = soulFor({ label: "x", program: true, ownTools: ["Read", "Write"] });
    expect(text).toContain("belong to that program");
    expect(text).toContain("its own engine, which has its own tools: Read, Write");
    expect(text).toContain("This conversation does not use them.");
    expect(soulFor({ label: "x", tools: ["Read"] })).not.toContain("belong to that program");
  });
  test("a small model gets a short version", () => {
    const small = soulFor({ label: "a small model", small: true });
    expect(words(small)).toBeLessThan(130);
    const named = [...small.matchAll(/\/([a-z]+)/g)].map((m) => m[1]!);
    for (const name of named) expect(SLASH_COMMANDS.map((c) => c.name)).toContain(name);
    expect(named).toEqual(expect.arrayContaining(["model", "checkpoints", "restore", "clear"]));
    expect(small).not.toContain("How navvied works");
  });
  test("it carries the user's standing instructions, shortened when very long", () => {
    expect(soulFor({ label: "x" }, "Use tabs.")).toContain("Use tabs.");
    expect(soulFor({ label: "x" }, "   ")).not.toContain("standing instructions for this work");
    const long = soulFor({ label: "x" }, "a".repeat(20_000));
    expect(long).toContain("[notes shortened]");
    expect(long.length).toBeLessThan(11_000);
  });
});
