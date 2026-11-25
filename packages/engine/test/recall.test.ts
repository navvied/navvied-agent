import { describe, expect, test } from "bun:test";
import { Jobs, defaultTools } from "../src/index.ts";
import { toolsFor } from "../src/permissions.ts";
import { prompt, rig } from "./helpers.ts";
import type { Recall, ToolContext } from "../src/types.ts";

const recallTool = defaultTools().find((t) => t.name === "Recall")!;
const past: Recall = {
  search: (q) => (q.includes("grpc") ? [{ id: "abc123", title: "Port the API to gRPC", snippet: "we chose [grpc] because", updated: Date.UTC(2026, 10, 12), n: 3 }] : q.includes("tresor") ? [{ id: "de1", title: "Gespraech", snippet: "[Tresor] Der Ersatzschluessel liegt im Tresor, Code sk-abcdefghijklmnopqrstuvwxyz0123", updated: Date.UTC(2026, 10, 13), n: 2 }] : []),
  read: (id) => (id === "abc123" ? [{ k: "user", text: "Should we use grpc?" }, { k: "tool", text: "Read" }, { k: "assistant", text: "Yes, for the streaming." }] : id === "long" ? Array.from({ length: 40 }, (_, i) => ({ k: i % 2 ? "assistant" : "user", text: `message ${i + 1} ${"w".repeat(300)}` })) : undefined),
  recent: (n) => [{ id: "abc123", title: "Port the API to gRPC", updated: Date.UTC(2026, 10, 12) }, { id: "old", title: "Older", updated: 1 }].slice(0, n),
};
const ctx = (recall?: Recall): ToolContext => ({ cwd: ".", signal: new AbortController().signal, emit: () => undefined, allowPrivateNetwork: false, jobs: new Jobs(() => undefined), ...(recall ? { recall } : {}) });

describe("looking through earlier conversations", () => {
  test("the words of the request offer it at once; in any other language it is named in the prompt, and a call is run", () => {
    const all = defaultTools();
    const names = (userText: string, recall: boolean) => toolsFor("auto", all, { small: true, userText, jobs: 0, recall }).map((t) => t.name);
    expect(names("what did we decide last time about the API?", true)).toContain("Recall");
    expect(names("fix the failing test in src/a.ts", true)).not.toContain("Recall");
    expect(names("what did we decide last time?", false)).not.toContain("Recall");
  });
  test("in another language it is named (when there are earlier conversations) and a call works", async () => {
    const r = rig((req) => (req.messages.at(-1)?.role === "tool" ? { text: String(req.messages.at(-1)!.content).slice(0, 60) } : { calls: [{ name: "Recall", args: { query: "tresor" } }] }), { recall: past });
    await r.turn(prompt("was haben wir gestern ueber den Tresor beschlossen?"));
    expect(r.provider.requests[0]!.system).toContain("Recall");
    expect(r.provider.requests[0]!.tools.map((t) => t.name)).not.toContain("Recall");
    expect(r.text()).toContain("Gespraech (id de1");
    expect(r.text()).not.toContain("sk-abcdefgh");
    r.cleanup();
    const none = rig(() => ({ text: "x" }));
    await none.turn(prompt("was haben wir gestern beschlossen?"));
    expect(none.provider.requests[0]!.system).not.toContain("Recall");
    none.cleanup();
  });
  test("a search lists the conversations with an id, a date, the message and a snippet; an id reads one with numbered messages", async () => {
    expect(await recallTool.run({ query: "grpc" }, ctx(past))).toBe("- Port the API to gRPC (id abc123, 2026-11-12, message 3): we chose [grpc] because");
    expect(await recallTool.run({ id: "abc123" }, ctx(past))).toBe("Messages 1-3:\n1 User: Should we use grpc?\n3 Assistant: Yes, for the streaming.");
  });

  test("words in another language work the same, and a secret in a result is never shown", async () => {
    const found = await recallTool.run({ query: "tresor" }, ctx(past));
    expect(found).toContain("[Tresor] Der Ersatzschluessel liegt im Tresor");
    expect(found).not.toContain("sk-abcdefghijklmnopqrstuvwxyz0123");
  });

  test("a long conversation is read in windows, around a message, with the way to the next window; with no words it lists the latest", async () => {
    const first = await recallTool.run({ id: "long" }, ctx(past));
    expect(first).toMatch(/^Messages 1-\d+ \(more: around=\d+\):\n1 User: message 1 /);
    expect(first.length).toBeLessThan(7_500);
    const mid = await recallTool.run({ id: "long", around: 20 }, ctx(past));
    expect(mid).toContain("\n20 Assistant: message 20 ");
    expect(mid.startsWith("Messages 17-")).toBe(true);
    expect(await recallTool.run({ limit: 1 }, ctx(past))).toBe("- Port the API to gRPC (id abc123, 2026-11-12)");
  });

  test("nothing found, a wrong id, and no earlier conversations are each a plain sentence; models' own words for the arguments are understood", async () => {
    expect(await recallTool.run({ query: "zzz" }, ctx(past))).toContain('No earlier conversation mentions "zzz"');
    expect(await recallTool.run({ id: "nope" }, ctx(past))).toContain("there is no earlier conversation");
    expect(await recallTool.run({ query: "x" }, ctx())).toContain("not available here");
    expect(await recallTool.run(recallTool.fixArgs!({ q: "grpc" }), ctx(past))).toContain("abc123");
  });
});
