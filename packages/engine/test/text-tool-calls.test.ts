import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { TextToolCalls, dollarCommand } from "../src/text-tool-calls.ts";
import { cleanupAll, prompt, rig } from "./helpers.ts";

afterAll(cleanupAll);

const SCHEMAS = { Read: { properties: { file_path: { type: "string" }, limit: { type: "integer" } } }, Todo: { properties: { todos: { type: "array" } } } };
const QWEN = "<tool_call>\n<function=Read>\n<parameter=file_path>\n/tmp/a b.txt\n</parameter>\n<parameter=limit>\n20\n</parameter>\n</function>\n</tool_call>";

/** Feeds the text in pieces of `size` characters, as a stream would. */
function run(text: string, size: number) {
  const f = new TextToolCalls(SCHEMAS, "t_");
  let shown = "";
  for (let i = 0; i < text.length; i += size) shown += f.push(text.slice(i, i + size));
  shown += f.finish();
  return { shown, calls: f.calls, kept: f.shown };
}

describe("a call written out as text", () => {
  test("becomes a call with typed arguments, however the stream is cut", () => {
    for (const size of [1, 2, 3, 5, 7, 1000]) {
      const r = run(`Let me look. ${QWEN} Done.`, size);
      expect(r.calls).toEqual([{ id: "t_0", name: "Read", arguments: JSON.stringify({ file_path: "/tmp/a b.txt", limit: 20 }) }]);
      expect(r.shown).toBe("Let me look. Done.");
      expect(r.kept).toBe(r.shown);
    }
  });
  test("a function block without its opening tag, followed by a stray closing tag", () => {
    const r = run("text\n<function=Todo>\n<parameter=todos>\n[]\n</parameter>\n</function>\n</tool_call>\nafter", 4);
    expect(r.calls.map((c) => [c.name, c.arguments])).toEqual([["Todo", '{"todos":[]}']]);
    expect(r.shown).toBe("text\nafter");
  });
  test("the JSON form used by other models", () => {
    const r = run('<tool_call>\n{"name": "Read", "arguments": {"file_path": "x"}}\n</tool_call>', 3);
    expect(r.calls.map((c) => [c.name, c.arguments])).toEqual([["Read", '{"file_path":"x"}']]);
    expect(r.shown).toBe("");
  });
  test("several calls in one reply keep their order and get their own ids", () => {
    const r = run(`${QWEN}\n${QWEN}`, 6);
    expect(r.calls.map((c) => c.id)).toEqual(["t_0", "t_1"]);
  });
  test("ordinary text with angle brackets is left alone", () => {
    for (const text of ["if a < b and c > d then <b>bold</b>", "ends with <", "ends with <func", "x </tool"]) expect(run(text, 2).shown).toBe(text);
  });
  test("a block that never closes, or cannot be read, is shown instead of lost", () => {
    expect(run("start <function=Read>\n<parameter=file_path>", 5).shown).toBe("start <function=Read>\n<parameter=file_path>");
    const broken = "<tool_call>not json at all</tool_call>";
    const r = run(broken, 4);
    expect(r.calls).toEqual([]);
    expect(r.shown).toBe(broken);
  });
});

describe("the engine with a model that writes its calls as text", () => {
  test("runs the call, hides the markup, and answers from the result", async () => {
    const r = rig((req, _n, dir) => {
      if (req.messages.at(-1)?.role === "tool") return { text: "written" };
      return { text: `I will write it.\n<tool_call>\n<function=Write>\n<parameter=file_path>\n${join(dir, "out.txt")}\n</parameter>\n<parameter=content>\nhello\n</parameter>\n</function>\n</tool_call>` };
    });
    await r.turn(prompt("write the file"));
    expect(existsSync(join(r.dir, "out.txt"))).toBe(true);
    expect(readFileSync(join(r.dir, "out.txt"), "utf8")).toBe("hello");
    expect(r.text()).not.toContain("<function");
    expect(r.text()).not.toContain("tool_call");
    expect(r.text()).toContain("I will write it.");
    expect(r.of("tool").some((e) => e.name === "Write" && e.status === "done")).toBe(true);
    const asked = r.provider.requests[1]!.messages.find((m) => m.role === "assistant");
    expect(asked?.content).toBe("I will write it.\n");
    expect(asked?.toolCalls?.[0]?.name).toBe("Write");
  });
});

describe("a reply that ends with $ lines", () => {
  const cases: [string, string, string | undefined][] = [
    ["a command after a sentence", "I will list the files.\n$ ls -la", "ls -la"],
    ["several lines run one after another", "First build, then test.\n$ npm ci\n$ npm test\n", "npm ci && npm test"],
    ["a path or a home folder starts a command", "$ ./run.sh --fast", "./run.sh --fast"],
    ["a dollar inside a sentence is text", "It costs $ 5 and the shell shows $ ls", undefined],
    ["a price at the start of a line is text", "$ 5 off today", undefined],
    ["a line that is not at the end is an example", "Run this:\n$ rm -rf build\nand then tell me what you saw.", undefined],
    ["an indented line is quoted text", "Output:\n  $ ls", undefined],
    ["a prompt inside a code block is text", "Try:\n```bash\n$ ls -la\n```", undefined],
    ["a block that is still open is text", "Try:\n```bash\n$ ls -la", undefined],
    ["a block after a closed code block still counts", "Earlier:\n```\nx\n```\nNow:\n$ pwd", "pwd"],
    ["an empty command is nothing", "$ \n", undefined],
    ["no dollar at all", "Everything is done.", undefined],
  ];
  test.each(cases)("%s", (_name, reply, command) => expect(dollarCommand(reply)).toBe(command));
});

describe("the engine runs a $ line for a model that cannot call tools", () => {
  test("the line becomes a Bash call and the output goes back to the model; a model that already called a tool is not second-guessed", async () => {
    const r = rig((req) => (req.messages.some((m) => m.role === "tool") ? { text: "Done." } : { text: "Let me look.\n$ echo from-a-dollar-line" }));
    await r.turn(prompt("show me"));
    const tool = r.of("tool").find((e) => e.status === "done");
    expect(tool?.name).toBe("Bash");
    expect(tool?.output).toContain("from-a-dollar-line");
    expect(r.provider.requests).toHaveLength(2);
    r.cleanup();
    const native = rig((req) => (req.messages.some((m) => m.role === "tool") ? { text: "ok" } : { text: "Trying:\n$ echo no", calls: [{ name: "Bash", args: { command: "echo yes" } }] }));
    await native.turn(prompt("go"));
    expect(native.of("tool").filter((e) => e.status === "done").map((e) => e.output)).toEqual(["yes"]);
    native.cleanup();
  });
});
