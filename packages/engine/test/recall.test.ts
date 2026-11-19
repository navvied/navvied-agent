import { describe, expect, test } from "bun:test";
import { Jobs, defaultTools } from "../src/index.ts";
import { toolsFor } from "../src/permissions.ts";
import type { Recall, ToolContext } from "../src/types.ts";

const recallTool = defaultTools().find((t) => t.name === "Recall")!;
const past: Recall = {
  search: (q) => (q.includes("grpc") ? [{ id: "abc123", title: "Port the API to gRPC", snippet: "we chose [grpc] because", updated: Date.UTC(2026, 10, 12) }] : []),
  read: (id) => (id === "abc123" ? [{ k: "user", text: "Should we use grpc?" }, { k: "assistant", text: "Yes, for the streaming." }, { k: "tool", text: "Read" }] : undefined),
};
const ctx = (recall?: Recall): ToolContext => ({ cwd: ".", signal: new AbortController().signal, emit: () => undefined, allowPrivateNetwork: false, jobs: new Jobs(() => undefined), ...(recall ? { recall } : {}) });

describe("looking through earlier conversations", () => {
  test("it is offered only when the person refers to something from before, and only where there are earlier conversations", () => {
    const all = defaultTools();
    const names = (userText: string, recall: boolean) => toolsFor("auto", all, { small: true, userText, jobs: 0, recall }).map((t) => t.name);
    expect(names("what did we decide last time about the API?", true)).toContain("Recall");
    expect(names("what did you tell me about the login in the other conversation?", true)).toContain("Recall");
    expect(names("fix the failing test in src/a.ts", true)).not.toContain("Recall");
    expect(names("what did we decide last time?", false)).not.toContain("Recall");
  });

  test("a search lists the conversations with an id, a date and a snippet; an id reads one", async () => {
    const found = await recallTool.run({ query: "grpc" }, ctx(past));
    expect(found).toBe("- Port the API to gRPC (id abc123, 2026-11-12): we chose [grpc] because");
    const read = await recallTool.run({ id: "abc123" }, ctx(past));
    expect(read).toBe("User: Should we use grpc?\nAssistant: Yes, for the streaming.\nTool: Read");
  });

  test("nothing found, a wrong id, no words, and no earlier conversations are each a plain sentence", async () => {
    expect(await recallTool.run({ query: "zzz" }, ctx(past))).toBe('No earlier conversation mentions "zzz".');
    expect(await recallTool.run({ id: "nope" }, ctx(past))).toContain("there is no earlier conversation");
    expect(await recallTool.run({}, ctx(past))).toContain("give words to look for");
    expect(await recallTool.run({ query: "x" }, ctx())).toContain("not available here");
  });
});
