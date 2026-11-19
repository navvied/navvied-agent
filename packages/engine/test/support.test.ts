import { describe, expect, test } from "bun:test";
import { ApprovalBroker, COMPACT_AT, compactMessages, estimateTokens, needsApproval, shouldCompact, toolsFor, defaultTools } from "../src/index.ts";
import { systemPrompt } from "../src/prompt.ts";
import type { Message, Provider } from "../src/types.ts";

describe("approval broker", () => {
  test("an answer resolves exactly the request it names, once", async () => {
    const b = new ApprovalBroker();
    const a = b.open(), c = b.open();
    expect(a.id).not.toBe(c.id);
    expect(b.pending).toBe(2);
    expect(b.answer(a.id, "allow")).toBe(true);
    expect(await a.answer).toEqual({ optionId: "allow" });
    expect(b.answer(a.id, "deny")).toBe(false); // a duplicate answer is ignored
    expect(b.answer("nope", "allow")).toBe(false);
    expect(b.pending).toBe(1);
  });
  test("denyAll denies everything still waiting", async () => {
    const b = new ApprovalBroker();
    const x = b.open(), y = b.open();
    b.denyAll();
    expect(await Promise.all([x.answer, y.answer])).toEqual([{ optionId: "deny" }, { optionId: "deny" }]);
    expect(b.pending).toBe(0);
  });
});

describe("permissions", () => {
  const all = defaultTools();
  test("plan offers only read-only tools plus the plan tool; ask and auto offer everything", () => {
    const running = { small: false, userText: "open https://example.com in the browser, and what did we decide last time", jobs: 1, typable: 1, skills: 1, recall: true };
    expect(toolsFor("plan", all).map((t) => t.name)).toEqual(["Read", "Glob", "Grep", "WebFetch", "WebSearch", "Agent", "TodoWrite", "ExitPlanMode"]);
    expect(toolsFor("ask", all, running)).toHaveLength(all.length);
    expect(toolsFor("auto", all, running)).toHaveLength(all.length);
    expect(toolsFor("auto", all).map((t) => t.name)).not.toContain("KillShell");
    expect(toolsFor("auto", all).map((t) => t.name)).not.toContain("BashInput");
  });
  test("only ask mode pauses, and only for tools that can change things", () => {
    const write = all.find((t) => t.name === "Write")!, read = all.find((t) => t.name === "Read")!;
    expect(needsApproval("ask", write)).toBe(true);
    expect(needsApproval("ask", read)).toBe(false);
    expect(needsApproval("auto", write)).toBe(false);
    expect(needsApproval("plan", write)).toBe(false); // never reachable: not offered
  });
});

describe("context", () => {
  test("estimate grows with content; the compaction threshold is the stated share of the window", () => {
    const small: Message[] = [{ role: "user", content: "hi" }];
    expect(estimateTokens([...small, { role: "assistant", content: "x".repeat(1000) }])).toBeGreaterThan(estimateTokens(small));
    expect(shouldCompact(COMPACT_AT * 1000 + 1, 1000)).toBe(true);
    expect(shouldCompact(COMPACT_AT * 1000, 1000)).toBe(false);
  });

  const provider: Provider = { stream: () => { throw new Error("unused"); }, complete: async () => "  the summary  " };
  const signal = new AbortController().signal;

  test("compaction keeps the recent tail and never starts it with an orphaned tool result", async () => {
    const msgs: Message[] = [
      { role: "user", content: "u1" }, { role: "assistant", content: "a1" },
      { role: "user", content: "u2" }, { role: "assistant", toolCalls: [{ id: "c", name: "Read", arguments: "{}" }] },
      { role: "tool", toolCallId: "c", content: "result" }, { role: "assistant", content: "a2" },
      { role: "user", content: "u3" }, { role: "assistant", content: "a3" },
    ];
    const out = (await compactMessages(msgs, provider, signal))!;
    expect(String(out[0]!.content)).toBe("[Summary of the earlier conversation]\nthe summary");
    expect(out[1]).toMatchObject({ role: "assistant" });
    const tail = out.slice(2);
    expect(tail[0]!.role).not.toBe("tool");
    expect(tail.at(-1)).toEqual({ role: "assistant", content: "a3" });
    expect(tail.length).toBeLessThanOrEqual(4);
  });

  test("too little to summarise → null; a provider failure propagates (the caller keeps the conversation)", async () => {
    expect(await compactMessages([{ role: "user", content: "hi" }], provider, signal)).toBeNull();
    const failing: Provider = { ...provider, complete: async () => { throw new Error("down"); } };
    const many: Message[] = Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `m${i}` }) as Message);
    await expect(compactMessages(many, failing, signal)).rejects.toThrow("down");
  });
});

describe("system prompt", () => {
  const info = { cwd: "/work", platform: "linux", date: "2026-01-02" };
  test("states the environment; persona first; plan note only in plan mode", () => {
    const p = systemPrompt({ ...info, persona: "You are Atlas." }, "auto");
    expect(p.startsWith("You are Atlas.")).toBe(true);
    expect(p).toContain("Working directory: /work");
    expect(p).toContain("2026-01-02");
    expect(p).not.toContain("PLAN MODE");
    expect(systemPrompt(info, "plan")).toContain("PLAN MODE");
  });
});
