import { describe, expect, test } from "bun:test";
import { systemPrompt } from "../src/prompt.ts";

describe("a change to code leaves comments and strings", () => {
  const info = { cwd: "/p", platform: "linux", date: "2026-01-01", kind: "agent" as const };
  const line = "A change to code changes code: leave comments and strings unless asked.";

  test("a model that is not small is told once, in one short line, in work and in plan mode", () => {
    for (const mode of ["auto", "plan"] as const) expect(systemPrompt(info, mode).split(line).length).toBe(2);
    expect(line.length).toBeLessThan(90);
  });

  test("a small model's prompt and a chat's stay as they were", () => {
    expect(systemPrompt({ ...info, small: true }, "auto")).not.toContain(line);
    expect(systemPrompt({ ...info, kind: "chat" }, "auto")).not.toContain(line);
  });
});
