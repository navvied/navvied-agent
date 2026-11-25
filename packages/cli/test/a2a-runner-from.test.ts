import { describe, expect, test } from "bun:test";
import type { AgentEngine } from "@navvied/engine";
import type { Command } from "@navvied/protocol";
import { engineRunner } from "../src/a2a-runner.ts";

describe("a turn that comes from another agent", () => {
  test("is handed to the engine as a prompt that says who asked", async () => {
    const seen: Command[] = [];
    const engine = { handle: (c: Command) => { seen.push(c); }, idle: async () => undefined, close() {} } as unknown as AgentEngine;
    const runner = engineRunner(() => ({ ok: true, value: engine }), "plan");
    const r = await runner.run({ peer: "docs", context: "c1", from: { agent: "Docs helper", name: "docs" }, text: "hello", signal: new AbortController().signal, progress() {} });
    expect(r.state).toBe("completed");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ cmd: "prompt", mode: "plan", from: { agent: "Docs helper", name: "docs" } });
  });
});
