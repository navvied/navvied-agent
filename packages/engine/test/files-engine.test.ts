import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { judge } from "../src/judge.ts";
import { Rules, hardBlock, parseRules } from "../src/rules.ts";
import { approvalScope } from "../src/approval-scope.ts";
import { riskOf } from "../src/risk.ts";
import { tool } from "./files-support.ts";
import { cleanupAll, prompt, rig, until, type Step } from "./helpers.ts";
import type { ModelRequest } from "../src/types.ts";

afterAll(cleanupAll, 30_000);

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
/** A model that makes the calls it is given, one after another, then says it is done. */
const steps = (...calls: { name: string; args: object }[]) => (req: ModelRequest): Step => {
  const done = req.messages.filter((m) => m.role === "tool").length;
  return done < calls.length ? { calls: [calls[done]!] } : { text: "done" };
};
const toolOutputs = (r: ReturnType<typeof rig>): string[] => r.of("tool").filter((e) => e.status !== "running").map((e) => e.output ?? "");

describe("a picture read by the model", () => {
  test("reaches it as a picture in the message after the result, so every provider can send it", async () => {
    const r = rig(steps({ name: "Read", args: { file_path: "chart.png" } }), { vision: true });
    writeFileSync(join(r.dir, "chart.png"), PNG);
    await r.turn(prompt("what is in chart.png?"));
    const next = r.provider.requests[1]!.messages;
    expect(next.at(-2)!.role).toBe("tool");
    const picture = next.at(-1)!;
    expect(picture.role).toBe("user");
    expect(picture.content).toEqual([{ type: "text", text: "The picture from the tool result above:" }, { type: "image", mime: "image/png", data: PNG.toString("base64") }]);
    r.cleanup();
  });
  test("a model that cannot see pictures gets the words and no picture", async () => {
    const r = rig(steps({ name: "Read", args: { file_path: "chart.png" } }), { vision: false });
    writeFileSync(join(r.dir, "chart.png"), PNG);
    await r.turn(prompt("what is in chart.png?"));
    expect(toolOutputs(r)[0]).toMatch(/This model cannot see pictures/);
    expect(JSON.stringify(r.provider.requests[1]!.messages)).not.toContain(PNG.toString("base64"));
    r.cleanup();
  });
  test("pictures of two parallel reads both come after all the results", async () => {
    const r = rig((req) => (req.messages.some((m) => m.role === "tool") ? { text: "done" } : { calls: [{ name: "Read", args: { file_path: "a.png" } }, { name: "Read", args: { file_path: "b.png" } }] }), { vision: true });
    writeFileSync(join(r.dir, "a.png"), PNG); writeFileSync(join(r.dir, "b.png"), PNG);
    await r.turn(prompt("look"));
    const roles = r.provider.requests[1]!.messages.map((m) => m.role);
    expect(roles.slice(-4)).toEqual(["assistant", "tool", "tool", "user"]);
    expect((r.provider.requests[1]!.messages.at(-1)!.content as unknown[]).length).toBe(3);
    r.cleanup();
  });
});

describe("the files a conversation has read, through the engine", () => {
  test("an edit of a file that was not read is refused with the call to make, and works once it was", async () => {
    const r = rig(steps(
      { name: "Edit", args: { file_path: "a.txt", old_string: "one", new_string: "1" } },
      { name: "Read", args: { file_path: "a.txt" } },
      { name: "Edit", args: { file_path: "a.txt", old_string: "one", new_string: "1" } },
    ), { });
    writeFileSync(join(r.dir, "a.txt"), "one\n");
    await r.turn(prompt("change it", { mode: "auto" }));
    const out = toolOutputs(r);
    expect(out[0]).toContain('Read {"file_path": ');
    expect(out[2]).toMatch(/^Edited/);
    expect(readFileSync(join(r.dir, "a.txt"), "utf8")).toBe("1\n");
    r.cleanup();
  });
  test("a file changed by a command after it was read is not edited from the old text", async () => {
    const r = rig(steps(
      { name: "Read", args: { file_path: "a.txt" } },
      { name: "Bash", args: { command: "printf 'two\\n' > a.txt" } },
      { name: "Edit", args: { file_path: "a.txt", old_string: "one", new_string: "1" } },
    ));
    writeFileSync(join(r.dir, "a.txt"), "one\n");
    await r.turn(prompt("change it", { mode: "auto" }));
    expect(toolOutputs(r)[2]).toMatch(/changed after you read it/);
    expect(readFileSync(join(r.dir, "a.txt"), "utf8")).toBe("two\n");
    r.cleanup();
  });
  test("a part read twice is answered with a stub, but after the conversation is summarised it is given in full again and an edit still goes through", async () => {
    const read = { calls: [{ name: "Read", args: { file_path: "a.txt" } }] };
    const plan: Step[] = [read, read, { text: "ok" }];
    const r = rig(() => plan.shift() ?? { text: "ok" });
    writeFileSync(join(r.dir, "a.txt"), "one\n");
    await r.turn(prompt(`read it ${"x".repeat(600)}`, { mode: "auto" }));
    expect(toolOutputs(r)[1]).toMatch(/unchanged since you read it/);
    for (let i = 0; i < 3; i++) await r.turn(prompt(`question ${i} ${"x".repeat(600)}`));
    await r.turn({ cmd: "compact" });
    plan.push(read, { calls: [{ name: "Edit", args: { file_path: "a.txt", old_string: "one", new_string: "1" } }] }, { text: "ok" });
    await r.turn(prompt("again", { mode: "auto" }));
    const out = toolOutputs(r);
    expect(out.at(-2)).toContain("     1\tone");
    expect(out.at(-1)).toMatch(/^Edited/);
    r.cleanup();
  });
  test("the files apply_patch changes are covered by the turn's checkpoint, like those of Edit", async () => {
    const r = rig(steps({ name: "apply_patch", args: { patch: "*** Begin Patch\n*** Add File: n.txt\n+x\n*** End Patch" } }), { applyPatch: "on" });
    await r.turn(prompt("add a file", { mode: "auto" }));
    expect(readFileSync(join(r.dir, "n.txt"), "utf8")).toBe("x\n");
    r.cleanup();
  });
  test("MultiEdit and apply_patch come after the first step on a large window, never on a small one unless the switch says so", async () => {
    const names = (r: ReturnType<typeof rig>, n: number): string[] => r.provider.requests[n]!.tools.map((t) => t.name);
    const work = steps({ name: "Read", args: { file_path: "a.txt" } });
    const large = rig(work);
    writeFileSync(join(large.dir, "a.txt"), "x\n");
    await large.turn(prompt("look at it", { mode: "auto" }));
    expect(names(large, 0)).not.toContain("MultiEdit");
    expect(names(large, 0)).not.toContain("apply_patch");
    expect(names(large, 1)).toEqual(expect.arrayContaining(["MultiEdit", "apply_patch"]));
    const small = rig(work, { window: 8_000, small: true });
    writeFileSync(join(small.dir, "a.txt"), "x\n");
    await small.turn(prompt("look at it", { mode: "auto" }));
    expect(names(small, 1)).not.toContain("MultiEdit");
    expect(names(small, 1)).not.toContain("apply_patch");
    const forced = rig(() => ({ text: "x" }), { window: 8_000, small: true, applyPatch: "on" });
    await forced.turn(prompt("hi"));
    expect(names(forced, 0)).toContain("apply_patch");
    const never = rig(work, { applyPatch: "off" });
    writeFileSync(join(never.dir, "a.txt"), "x\n");
    await never.turn(prompt("look at it", { mode: "auto" }));
    expect(names(never, 1)).not.toContain("apply_patch");
    large.cleanup(); small.cleanup(); forced.cleanup(); never.cleanup();
  });
});

describe("the permissions of the tools that change files", () => {
  const cwd = "/work/proj";
  const patchFor = (...paths: string[]): { patch: string } => ({ patch: `*** Begin Patch\n${paths.map((p) => `*** Add File: ${p}\n+x`).join("\n")}\n*** End Patch` });
  const input = (name: string, args: Record<string, unknown>, mode: "ask" | "edits" | "auto" = "ask", rules?: Rules) => ({ mode, tool: tool(name), args, cwd, allowed: new Set<string>(), knownUrl: () => false, ...(rules ? { rules } : {}) });

  test("MultiEdit, NotebookEdit and apply_patch are asked about in ask mode, and let through in edits mode, like Edit", () => {
    for (const [name, args] of [["Edit", { file_path: "a.ts" }], ["MultiEdit", { file_path: "a.ts", edits: [] }], ["NotebookEdit", { file_path: "a.ipynb" }], ["apply_patch", patchFor("a.ts")]] as const) {
      expect(judge(input(name, args)).kind, name).toBe("ask");
      expect(judge(input(name, args, "edits")).kind, name).toBe("go");
    }
  });
  test("a rule written for Edit covers the others, for every file of a patch", () => {
    const rules = new Rules(parseRules({ deny: ["Edit(secrets/**)"], allow: ["Edit(src/**)"] }), cwd);
    expect(judge(input("MultiEdit", { file_path: "secrets/k.ts", edits: [] }, "auto", rules))).toMatchObject({ kind: "stop" });
    expect(judge(input("apply_patch", patchFor("src/a.ts", "secrets/k.txt"), "auto", rules))).toMatchObject({ kind: "stop" });
    expect(judge(input("apply_patch", patchFor("src/a.ts", "src/b.ts"), "ask", rules)).kind).toBe("go");
    expect(judge(input("apply_patch", patchFor("src/a.ts", "docs/b.md"), "ask", rules)).kind).toBe("ask");
    expect(judge(input("NotebookEdit", { file_path: "src/n.ipynb" }, "ask", rules)).kind).toBe("go");
  });
  test("the hard limits hold for every file of a patch and for the other tools", () => {
    const [one, two] = process.platform === "win32" ? ["C:\\Windows\\win.ini", "C:\\Windows\\System32\\hosts"] : ["/etc/passwd", "/etc/hosts"];
    expect(hardBlock("apply_patch", patchFor("src/a.ts", one!), cwd)).toMatch(/system folder/);
    expect(hardBlock("MultiEdit", { file_path: two! }, cwd)).toMatch(/system folder/);
    expect(hardBlock("NotebookEdit", { file_path: ".navvied/permissions.json" }, cwd)).toMatch(/allowed to do/);
    expect(hardBlock("apply_patch", patchFor("src/a.ts"), cwd)).toBeUndefined();
  });
  test("what is asked is a kind of change in each folder the patch touches, and a risky file is always asked", () => {
    expect(approvalScope("apply_patch", patchFor("src/a.ts", "docs/b.md", "/tmp/x.txt"), cwd)).toEqual({ key: "file:src", keys: ["file:src", "file:docs", "outside:/tmp"], phrase: "changes in src/ and changes in docs/ and changes in /tmp" });
    expect(approvalScope("MultiEdit", { file_path: "src/a.ts" }, cwd)).toEqual({ key: "file:src", phrase: "changes in src/" });
    expect(riskOf("apply_patch", patchFor("src/a.ts", ".bashrc"), cwd)).toMatchObject({ key: "risk:protected-path" });
  });
  test("Read, Glob and Grep of a place outside the project are asked about when a rule says so, and stopped when a rule denies", () => {
    const rules = new Rules(parseRules({ ask: ["Read(/home/**)", "Grep(/home/**)"], deny: ["Read(/etc/**)"] }), cwd);
    expect(judge({ ...input("Read", { file_path: "/home/other/notes.md" }, "auto", rules) }).kind).toBe("ask");
    expect(judge({ ...input("Grep", { pattern: "x", path: "/home/other" }, "auto", rules) }).kind).toBe("ask");
    expect(judge({ ...input("Read", { file_path: "/etc/shadow" }, "auto", rules) })).toMatchObject({ kind: "stop" });
    expect(judge({ ...input("Read", { file_path: "src/a.ts" }, "auto", rules) }).kind).toBe("go");
  });
});

describe("a look outside the project, through the engine", () => {
  test("asks in ask mode with the file's name, and a no is told to the model", async () => {
    const r = rig(steps({ name: "Read", args: { file_path: "/etc/hostname" } }));
    r.send(prompt("what is this computer called?", { mode: "ask" }));
    await until(() => r.of("approval").length > 0);
    expect(r.of("approval")[0]!.title).toBe("Read /etc/hostname");
    r.send({ cmd: "approve", id: r.of("approval")[0]!.id, optionId: "deny" });
    await r.engine.idle();
    expect(toolOutputs(r).at(-1)).toBe("The user denied this action.");
    r.cleanup();
  });
  test("a file of the project is read without asking", async () => {
    const r = rig(steps({ name: "Read", args: { file_path: "a.txt" } }));
    writeFileSync(join(r.dir, "a.txt"), "x\n");
    await r.turn(prompt("read it", { mode: "ask" }));
    expect(r.of("approval")).toEqual([]);
    r.cleanup();
  });
});

describe("a look at a place outside the project", () => {
  const cwd = "/work/proj";
  const readable = ["/tmp/navvied-output", "/tmp/att/s1", "/home/u/.navvied/memory"];
  const look = (name: string, args: Record<string, unknown>, mode: "ask" | "edits" | "auto" | "plan" | "bypass" = "ask", extra: { rules?: Rules; allowed?: Set<string>; readable?: string[] | undefined } = {}) =>
    judge({ mode, tool: tool(name), args, cwd, allowed: extra.allowed ?? new Set(), knownUrl: () => false, ...("readable" in extra ? { readable: extra.readable } : { readable }), ...(extra.rules ? { rules: extra.rules } : {}) });

  test("is asked about in the modes that ask, for Read, Glob and Grep, and not for the project's own files", () => {
    expect(look("Read", { file_path: "/home/other/notes.md" }).kind).toBe("ask");
    expect(look("Read", { file_path: "../other/a.ts" }, "edits").kind).toBe("ask");
    expect(look("Glob", { pattern: "**/*", path: "/home/other" }).kind).toBe("ask");
    expect(look("Grep", { pattern: "x", path: "/etc" }).kind).toBe("ask");
    expect(look("Read", { file_path: "src/a.ts" }).kind).toBe("go");
    expect(look("Read", { file_path: "/work/proj/src/a.ts" }).kind).toBe("go");
    expect(look("Grep", { pattern: "x" }).kind).toBe("go");
  });
  test("is not asked about in auto, bypass and plan mode, or by a program that does not say where it keeps its files", () => {
    for (const mode of ["auto", "bypass", "plan"] as const) expect(look("Read", { file_path: "/home/other/a" }, mode).kind, mode).toBe("go");
    expect(look("Read", { file_path: "/home/other/a" }, "ask", { readable: undefined }).kind).toBe("go");
  });
  test("is free in the folders the program keeps for the model: long output, attachments and notes", () => {
    for (const file of ["/tmp/navvied-output/o-1/output.txt", "/tmp/att/s1/report.pdf", "/home/u/.navvied/memory/notes.md"]) expect(look("Read", { file_path: file }).kind, file).toBe("go");
    expect(look("Read", { file_path: "/tmp/navvied-output-other/x" }).kind).toBe("ask");
  });
  test("what the person said to never ask again covers that folder only, and a rule that allows lets it through", () => {
    const other = resolve("/home/other");
    const asked = look("Read", { file_path: "/home/other/notes.md" });
    expect(asked.kind === "ask" && asked.scope).toEqual({ key: `read-outside:${other}`, phrase: `reads in ${other}` });
    expect(look("Read", { file_path: "/home/other/b.md" }, "ask", { allowed: new Set([`read-outside:${other}`]) }).kind).toBe("go");
    expect(look("Read", { file_path: "/home/third/b.md" }, "ask", { allowed: new Set([`read-outside:${other}`]) }).kind).toBe("ask");
    expect(look("Read", { file_path: "/home/other/b.md" }, "ask", { rules: new Rules(parseRules({ allow: ["Read(/home/other/**)"] }), cwd) }).kind).toBe("go");
    expect(look("Read", { file_path: "/home/other/b.md" }, "auto", { rules: new Rules(parseRules({ deny: ["Read(/home/**)"] }), cwd) }).kind).toBe("stop");
  });
});
