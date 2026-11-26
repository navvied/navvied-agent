import { afterAll, describe, expect, test } from "bun:test";
import { HOOK_MS, cleanupAll, prompt, rig } from "./helpers.ts";

afterAll(cleanupAll, HOOK_MS);
const lastIsTool = (req: { messages: { role: string }[] }): boolean => req.messages.at(-1)?.role === "tool";
const calls = (...c: { name: string; args: object }[]) => (req: { messages: { role: string }[] }) => (lastIsTool(req) ? { text: "done" } : { calls: c });
const outputs = (r: ReturnType<typeof rig>) => r.of("tool").filter((e) => e.status !== "running").map((e) => e.output ?? "");

describe("a tool that exists and is not offered", () => {
  test("is named in the prompt, without its definition, and a call to it is run, not refused", async () => {
    const r = rig(calls({ name: "WebFetch", args: { url: "http://127.0.0.1:1/" } }), { window: 8000, small: true });
    await r.turn(prompt("fix the bug in a.ts", { mode: "auto" }));
    const first = r.provider.requests[0]!;
    expect(first.tools.map((t) => t.name)).not.toContain("WebFetch");
    expect(first.system).toMatch(/Also available, by name: .*WebFetch.*WebSearch/);
    expect(outputs(r).join("")).not.toContain("there is no tool");
    r.cleanup();
  });

  test("once used it is still not offered: the list and the prompt stay as they were", async () => {
    const r = rig(calls({ name: "WebFetch", args: { url: "http://127.0.0.1:1/" } }), { window: 8000, small: true });
    await r.turn(prompt("fix the bug in a.ts", { mode: "auto" }));
    await r.turn(prompt("and now the other file", { mode: "auto" }));
    const [first, later] = [r.provider.requests[0]!, r.provider.requests.at(-1)!];
    expect(later.tools.map((t) => t.name)).toEqual(first.tools.map((t) => t.name));
    expect(later.system).toBe(first.system);
    r.cleanup();
  });

  test("a tool that is not offered is not a way round plan mode: only reading is allowed there", async () => {
    const r = rig(calls({ name: "Write", args: { file_path: "x.txt", content: "no" } }, { name: "TodoWrite", args: { todos: [{ content: "plan", status: "pending" }] } }));
    await r.turn(prompt("plan it", { mode: "plan" }));
    const out = outputs(r);
    expect(out.some((o) => o.includes('there is no tool "Write"'))).toBe(true);
    expect(r.of("plan").length).toBe(1);
    expect(r.provider.requests[0]!.system).not.toContain("Remember");
    r.cleanup();
  });

  test("a tool that does not exist is refused with the ones there are", async () => {
    const r = rig(calls({ name: "TeleportHome", args: {} }));
    await r.turn(prompt("fix it", { mode: "auto" }));
    expect(outputs(r).join("")).toContain('there is no tool "TeleportHome". Use one of: Read, Write, Edit, MultiEdit, NotebookEdit, apply_patch, Bash, Glob, Grep');
    r.cleanup();
  });
});

describe("the names models invent for the command tool", () => {
  test("bash, shell, terminal, run, execute_bash and a differently written Bash are the Bash tool", async () => {
    for (const name of ["bash", "shell", "terminal", "run", "execute_bash", "Run_Command", "BASH"]) {
      const r = rig(calls({ name, args: { command: "echo aliased" } }));
      await r.turn(prompt("say it", { mode: "auto" }));
      const done = r.of("tool").filter((e) => e.status === "done");
      expect(done.map((e) => `${e.name}:${e.output?.split("\n")[0]}`), name).toEqual(["Bash:aliased"]);
      r.cleanup();
    }
  });

  test("a name written another way is the tool it spells: web_search is WebSearch", async () => {
    const r = rig(calls({ name: "todo_write", args: { todos: [{ content: "x", status: "completed" }] } }));
    await r.turn(prompt("do it", { mode: "auto" }));
    expect(r.of("plan").length).toBe(1);
    r.cleanup();
  });
});

describe("a call that leaves out what is needed", () => {
  test("is answered with what to send, in the form the tool takes", async () => {
    const r = rig(calls({ name: "Bash", args: {} }));
    await r.turn(prompt("run it", { mode: "auto" }));
    expect(outputs(r)).toContain('Error: Bash needs command: {"command": "..."}. Send the call again with it.');
    r.cleanup();
  });
  test("a file edit says all it needs", async () => {
    const r = rig(calls({ name: "Edit", args: { file_path: "a.txt" } }));
    await r.turn(prompt("edit it", { mode: "auto" }));
    expect(outputs(r).join("")).toContain("Edit needs old_string, new_string:");
    r.cleanup();
  });
});
