import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defaultTools, toolsFor } from "../src/index.ts";
import type { ModelReply, ModelRequest, Provider } from "../src/index.ts";
import { messagesAsText, toolsInPrompt } from "../src/text-tools.ts";
import { HOOK_MS, cleanupAll, prompt, rig } from "./helpers.ts";

afterAll(cleanupAll, HOOK_MS);

/** A model whose server takes no tools: a request that carries them is refused the way such a server does, and the replies are what the model writes as text. */
class Toolless implements Provider {
  readonly seen: ModelRequest[] = [];
  constructor(private readonly replies: string[]) {}
  async stream(req: ModelRequest, _s: AbortSignal, on: { text(t: string): void }): Promise<ModelReply> {
    if (req.tools.length) throw Object.assign(new Error("tiny:135m does not support tools"), { status: 400 });
    this.seen.push(req);
    const content = this.replies[this.seen.length - 1] ?? "done";
    on.text(content);
    return { content, calls: [], finish: "stop" };
  }
  async complete(): Promise<string> { return ""; }
}

describe("the tools said in the prompt", () => {
  const offered = toolsFor("auto", defaultTools(), { small: true, userText: "make a file", jobs: 0, steps: 0, chat: false, typable: false, skills: 0 } as never);

  test("one line a tool, only the arguments a call must have, one example, and far less than the tool definitions", () => {
    const text = toolsInPrompt(offered);
    expect(text).toContain('<tool_call>{"name":"Read","arguments":{"file_path":"..."}}</tool_call>');
    expect(text).toContain("Write: Create a file, or replace it whole. Arguments: file_path, content.");
    expect(text).toContain("Arguments: file_path.");
    expect(text).toContain("$ command");
    expect(text.length).toBeLessThan(JSON.stringify(offered.map(({ name, description, parameters }) => ({ name, description, parameters }))).length / 2);
    expect(toolsInPrompt([])).toBe("");
  });

  test("a call it made is its own text again, and a result is a message of the person", () => {
    const out = messagesAsText([
      { role: "user", content: "go" },
      { role: "assistant", content: "ok", toolCalls: [{ id: "a", name: "Write", arguments: '{"file_path":"x","content":"y"}' }, { id: "b", name: "Read", arguments: "{}" }] },
      { role: "tool", toolCallId: "a", content: "wrote x" },
      { role: "tool", toolCallId: "b", content: "empty" },
    ]);
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(out[1]!.content).toBe('ok\n<tool_call>{"name":"Write","arguments":{"file_path":"x","content":"y"}}</tool_call>\n<tool_call>{"name":"Read","arguments":{}}</tool_call>');
    expect(out[2]!.content).toBe("Result of Write:\nwrote x\n\nResult of Read:\nempty");
  });
});

describe("a model that takes no tools still works in the agent", () => {
  test("the refusal is answered by the tools in the prompt: the call it writes is run, and its result goes back as text", async () => {
    const provider = new Toolless(['I will write it.\n<tool_call>{"name":"Write","arguments":{"file_path":"sum.py","content":"print(55)\\n"}}</tool_call>', "It is written."]);
    const r = rig(() => ({ text: "x" }), { provider });
    await r.turn(prompt("make sum.py", { mode: "auto" }));
    expect(existsSync(join(r.dir, "sum.py"))).toBe(true);
    expect(readFileSync(join(r.dir, "sum.py"), "utf8")).toBe("print(55)\n");
    expect(provider.seen).toHaveLength(2);
    expect(provider.seen[0]!.system).toContain("Write: Create a file, or replace it whole. Arguments: file_path, content.");
    expect(provider.seen[1]!.messages.some((m) => m.role === "tool" || m.toolCalls)).toBe(false);
    expect(provider.seen[1]!.messages.at(-1)!.content).toContain("Result of Write:");
    expect(r.of("text").map((e) => e.text).join("")).toContain("It is written.");
    expect(r.of("error")).toEqual([]);
    r.cleanup();
  });

  test("a line that starts with $ runs as a command", async () => {
    const provider = new Toolless(["$ echo hello-from-text > out.txt", "done"]);
    const r = rig(() => ({ text: "x" }), { provider });
    await r.turn(prompt("run echo", { mode: "auto" }));
    expect(readFileSync(join(r.dir, "out.txt"), "utf8").trim()).toBe("hello-from-text");
    r.cleanup();
  });
});
