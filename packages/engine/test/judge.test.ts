import { describe, expect, test } from "bun:test";
import type { PermMode } from "@navvied/protocol";
import { Rules, judge, type JudgeInput } from "../src/index.ts";

const cwd = "/work/project";
const call = (mode: PermMode, tool: string, args: Record<string, unknown>, more: Partial<JudgeInput> = {}) =>
  judge({ mode, tool: { name: tool, readOnly: ["Read", "Grep", "Glob", "WebFetch"].includes(tool) }, args, cwd, allowed: new Set(), knownUrl: () => true, ...more });
const kinds = (tool: string, args: Record<string, unknown>) => (["ask", "edits", "plan", "auto", "bypass"] as const).map((m) => call(m, tool, args).kind).join(" ");

describe("what each mode means, the same for every engine", () => {
  test("a plain look is asked about in no mode", () => {
    expect(kinds("Read", { file_path: "a.ts" })).toBe("go go go go go");
    expect(kinds("Bash", { command: "ls -la" })).toBe("go go go go go");
  });
  test("ask: changes and commands are asked about; edits: files go through and commands are asked about; plan, auto, bypass: not asked", () => {
    expect(kinds("Write", { file_path: "src/a.ts", content: "x" })).toBe("ask go go go go");
    expect(kinds("Bash", { command: "npm test" })).toBe("ask ask go go go");
    expect(kinds("Bash", { command: "mkdir out" })).toBe("ask go go go go");
  });
  test("what cannot be undone is asked about in every mode but Plan and Bypass, and what is never done is stopped in all five", () => {
    expect(kinds("Bash", { command: "git push --force origin main" })).toBe("ask ask go ask go");
    expect(new Set((["ask", "edits", "plan", "auto", "bypass"] as const).map((m) => call(m, "Bash", { command: "rm -rf ~" }).kind))).toEqual(new Set(["stop"]));
  });
  test("a deny rule stops, an ask rule asks (but not in Plan), an allow rule lets a command through and never a risky one", () => {
    const rules = new Rules({ deny: ["Bash(curl *)"], ask: ["Bash(make deploy)"], allow: ["Bash(git *)"] }, cwd);
    expect(call("bypass", "Bash", { command: "curl https://x.example" }, { rules }).kind).toBe("stop");
    expect(call("auto", "Bash", { command: "make deploy" }, { rules }).kind).toBe("ask");
    expect(call("plan", "Bash", { command: "make deploy" }, { rules }).kind).toBe("go");
    expect(call("ask", "Bash", { command: "git status" }, { rules }).kind).toBe("go");
    expect(call("auto", "Bash", { command: "git push --force origin main" }, { rules }).kind).toBe("ask");
  });
  test("what the person said not to ask again about is not asked again, except what cannot be undone", () => {
    const first = call("ask", "Bash", { command: "npm test" });
    if (first.kind !== "ask") throw new Error("expected a question");
    expect(call("ask", "Bash", { command: "npm test -- --bail" }, { allowed: new Set(first.scope.keys ?? [first.scope.key]) }).kind).toBe("go");
    const risky = call("auto", "Bash", { command: "npm publish" });
    if (risky.kind !== "ask") throw new Error("expected a question");
    expect(call("auto", "Bash", { command: "npm publish" }, { allowed: new Set([risky.scope.key]) }).kind).toBe("go");
    expect(risky.risk?.reason).toContain("publishes");
  });
  test("an address nobody gave is asked about (stopped in Edits), except in the modes that ask for nothing", () => {
    const args = { url: "https://x.example/p" };
    const unknown = { knownUrl: () => false };
    expect(call("ask", "WebFetch", args, unknown)).toMatchObject({ kind: "ask", strange: true });
    expect(call("edits", "WebFetch", args, unknown).kind).toBe("stop");
    expect(call("auto", "WebFetch", args, unknown).kind).toBe("go");
    expect(call("bypass", "WebFetch", args, unknown).kind).toBe("go");
  });

  test("a shell that reaches a cloud metadata address is asked about in every mode that asks about what cannot be undone (Auto too), and in no other", () => {
    const command = "curl http://169.254.169.254/latest/meta-data/iam/security-credentials/";
    expect(kinds("Bash", { command })).toBe("ask ask go ask go");
  });
});

describe("a skill of the project that the person has not accepted", () => {
  const held = () => [{ name: "deploy", dir: "/work/project/.navvied/skills/deploy" }];
  test("its files are not read, in any mode, whichever tool reads them", () => {
    for (const mode of ["ask", "edits", "plan", "auto", "bypass"] as const) {
      expect(call(mode, "Read", { file_path: "/work/project/.navvied/skills/deploy/SKILL.md" }, { held }).kind).toBe("stop");
      expect(call(mode, "Read", { file_path: ".navvied/skills/deploy/notes.md" }, { held }).kind).toBe("stop");
      expect(call(mode, "Grep", { pattern: "x", path: ".navvied/skills/deploy" }, { held }).kind).toBe("stop");
    }
    const stopped = call("auto", "Read", { file_path: ".navvied/skills/deploy/SKILL.md" }, { held });
    expect(stopped.kind === "stop" && stopped.message).toContain("has not accepted");
  });
  test("another skill, and the same files once it is accepted, are read as before", () => {
    expect(call("auto", "Read", { file_path: ".navvied/skills/other/SKILL.md" }, { held }).kind).toBe("go");
    expect(call("auto", "Read", { file_path: ".navvied/skills/deploy/SKILL.md" }, { held: () => [] }).kind).toBe("go");
  });
});
