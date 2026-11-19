import { describe, expect, test } from "bun:test";
import type { ApprovalOption, EngineEvent } from "@navvied/protocol";
import { askApproval, describeRequest } from "../src/approval-ui.ts";
import type { Choice, Frame, IO } from "../src/io.ts";

type Approval = Extract<EngineEvent, { ev: "approval" }>;

const bashOptions = (phrase: string, command: string): ApprovalOption[] => [
  { optionId: "allow", name: "Allow", kind: "allow_once" },
  { optionId: "allow_always", name: `Allow, and do not ask again for ${phrase}`, kind: "allow_always" },
  { optionId: "edit", name: "Edit", kind: "allow_once", editable: { value: command } },
  { optionId: "deny", name: "Deny", kind: "reject_once" },
];

/** A fake `io` that answers with the choice at `pick` (or the last option, when there is none to pick), and records what it was shown. */
function fakeChoose(pick?: number) {
  const asked: { title: string; items: Choice[]; frame?: Frame }[] = [];
  const io = {
    color: false,
    choose: async (title: string, items: Choice[], _initial?: number, frame?: Frame): Promise<number | undefined> => {
      asked.push({ title, items, frame });
      return pick;
    },
    text: async (): Promise<string | undefined> => undefined,
  } as unknown as IO;
  return { io, asked };
}

describe("remembering a command as a pattern", () => {
  test("a plain command offers a pattern taken from its own start, between Allow and the broad 'do not ask again'", async () => {
    const { io, asked } = fakeChoose(1);
    const e: Approval = { ev: "approval", id: "a1", title: "Run", options: bashOptions("npm commands", "npm test") };
    const answer = await askApproval(io, e, { name: "Bash", input: { command: "npm test" } }, "/work", 80);
    const labels = asked[0]!.items.map((i) => i.label);
    expect(labels).toEqual([
      "Yes",
      'Yes, and allow "npm test *" from now on',
      "Yes, and do not ask again for npm commands",
      "Change the command first",
      "No, I will tell it what to do instead",
    ]);
    expect(answer).toEqual({ optionId: "allow", pattern: "npm test *" });
  });

  test("a combined command offers one pattern per part, in the order the parts run", async () => {
    const { io, asked } = fakeChoose(2);
    const e: Approval = { ev: "approval", id: "a2", title: "Run", options: bashOptions("git commands", "git status && npm test") };
    const answer = await askApproval(io, e, { name: "Bash", input: { command: "git status && npm test" } }, "/work", 80);
    const labels = asked[0]!.items.map((i) => i.label);
    expect(labels).toEqual([
      "Yes",
      'Yes, and allow "git status *" from now on',
      'Yes, and allow "npm test *" from now on',
      "Yes, and do not ask again for git commands",
      "Change the command first",
      "No, I will tell it what to do instead",
    ]);
    expect(answer).toEqual({ optionId: "allow", pattern: "npm test *" });
  });

  test("nothing that cannot be undone offers a pattern, and the reason it is asked is shown instead", async () => {
    const { io, asked } = fakeChoose(0);
    const e: Approval = { ev: "approval", id: "a3", title: "Run", options: bashOptions("git reset --hard", "git reset --hard"), risk: "This throws away every change that has not been saved in a commit." };
    await askApproval(io, e, { name: "Bash", input: { command: "git reset --hard" } }, "/work", 80);
    const labels = asked[0]!.items.map((i) => i.label);
    expect(labels).toEqual(["Yes", "Yes, and do not ask again for git reset --hard", "Change the command first", "No, I will tell it what to do instead"]);
    expect(labels.some((l) => l.includes("from now on"))).toBe(false);
    expect(asked[0]!.frame?.notice).toEqual(["This throws away every change that has not been saved in a commit."]);
  });

  test("a non-Bash request offers no pattern at all", async () => {
    const { io, asked } = fakeChoose(0);
    const e: Approval = { ev: "approval", id: "a4", title: "Write", options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "allow_always", name: "Allow, and do not ask again for changes in src/", kind: "allow_always" }, { optionId: "deny", name: "Deny", kind: "reject_once" }] };
    await askApproval(io, e, { name: "Write", input: { file_path: "src/a.ts" } }, "/work", 80);
    const labels = asked[0]!.items.map((i) => i.label);
    expect(labels.some((l) => l.includes("from now on"))).toBe(false);
  });

  test("picking a plain Yes carries no pattern", async () => {
    const { io } = fakeChoose(0);
    const e: Approval = { ev: "approval", id: "a5", title: "Run", options: bashOptions("npm commands", "npm test") };
    const answer = await askApproval(io, e, { name: "Bash", input: { command: "npm test" } }, "/work", 80);
    expect(answer).toEqual({ optionId: "allow" });
  });
});

describe("what the request looks like", () => {
  test("a command is shown with a $ in front, a change as a diff, a write by its path", () => {
    expect(describeRequest({ name: "Bash", input: { command: "npm test" } }, "Run", "/work", false, 80)).toEqual({ heading: "It wants to run a command", lines: ["$ npm test"] });
    expect(describeRequest({ name: "Write", input: { file_path: "/work/a.ts" } }, "Write", "/work", false, 80)).toEqual({ heading: "It wants to write a file", lines: ["a.ts"] });
  });
});
