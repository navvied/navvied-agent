import { describe, expect, test } from "bun:test";
describe("how a connected model is described", () => {
  test("in plain words: on this computer, hosted, or through a program", async () => {
    const { describeEntry } = await import("../src/create.ts");
    expect(describeEntry({ baseUrl: "http://localhost:1234/v1" })).toBe("On this computer.");
    expect(describeEntry({ baseUrl: "https://x.example/v1" })).toBe("A hosted service.");
    expect(describeEntry({ baseUrl: "nonsense" })).toBe("A hosted service.");
    expect(describeEntry({ command: "x" })).toBe("Through a program you are signed in to.");
    expect(describeEntry({ command: "x", adapter: "codex" })).toBe("Through your ChatGPT plan.");
  });
});

