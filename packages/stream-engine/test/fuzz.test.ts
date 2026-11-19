import { expect, test } from "bun:test";
import { Translator } from "../src/index.ts";
import { garbage, mutate, pick, prng, value } from "../../protocol/test/prng.ts";

const VALID: Record<string, unknown>[] = [
  { type: "system", subtype: "init", session_id: "s1" },
  { type: "system", subtype: "status", status: "compacting" },
  { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "Bash" } } },
  { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } } },
  { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } } },
  { type: "assistant", message: { content: [{ type: "text", text: "hi" }, { type: "tool_use", id: "t1", name: "Edit", input: { file_path: "a" } }], usage: { input_tokens: 5, output_tokens: 2 } } },
  { type: "assistant", parent_tool_use_id: "p", message: { content: [{ type: "tool_use", id: "c", name: "Read", input: {} }] } },
  { type: "user", isReplay: true, uuid: "u1", message: {} },
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "ok" }] }] } },
  { type: "result", subtype: "success" },
];

test("the translator never throws on any input, and everything it emits is a well-formed event", () => {
  const r = prng(11);
  const t = new Translator({ window: 1000 });
  let emitted = 0;
  for (let i = 0; i < 5000; i++) {
    const line = r() < 0.2 ? value(r) : r() < 0.1 ? garbage(r) : mutate(r, pick(r, VALID));
    t.interrupting = r() < 0.1;
    const events = t.feed(line);
    expect(Array.isArray(events)).toBe(true);
    for (const e of events) {
      emitted++;
      expect(typeof e.ev).toBe("string");
      if (e.ev === "text" || e.ev === "thought") expect(typeof e.text).toBe("string");
      if (e.ev === "usage") expect([e.ctx, e.win, e.out].every(Number.isFinite)).toBe(true);
      if (e.ev === "tool") expect(typeof e.id === "string" && typeof e.name === "string").toBe(true);
      if (e.ev === "done") expect(typeof e.stop).toBe("string");
    }
  }
  expect(emitted).toBeGreaterThan(300);
});
