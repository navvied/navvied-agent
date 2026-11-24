import { describe, expect, test } from "bun:test";
import { bashFailed, describeFailure, describeStep, diffRows, parseBashOutput, shortPath, startLine, stepTail } from "../src/steps.ts";

describe("steps in plain words", () => {
  const cwd = "/Users/ana/shop";
  test("files are named as the person knows them", () => {
    expect(shortPath("/Users/ana/shop/src/a.ts", cwd)).toBe("src/a.ts");
    expect(shortPath("/Users/ana/notes/b.md", cwd)).toBe("~/notes/b.md");
    expect(shortPath("/etc/hosts", cwd)).toBe("/etc/hosts");
    expect(shortPath("C:\\work\\shop\\src\\a.ts", "C:\\work\\shop")).toBe("src/a.ts");
    expect(shortPath("rel/a.ts", cwd)).toBe("rel/a.ts");
  });
  test("each tool says what it is doing and what it did", () => {
    expect(describeStep("Read", { file_path: "/Users/ana/shop/a.ts" }, cwd)).toEqual({ running: "Reading a.ts", done: "Read a.ts" });
    expect(describeStep("Edit", { file_path: "a.ts" }, cwd).done).toBe("Changed a.ts");
    expect(describeStep("Write", { file_path: "a.ts" }, cwd).done).toBe("Wrote a.ts");
    expect(describeStep("Bash", { command: "npm   test" }, cwd).done).toBe("Ran npm test");
    expect(describeStep("Bash", { command: "x", description: "Run the tests" }, cwd).done).toBe("Run the tests");
    expect(describeStep("WebFetch", { url: "https://example.com/p?q=1" }, cwd).done).toBe("Opened example.com");
    expect(describeStep("Grep", { pattern: "discount" }, cwd).done).toBe("Searched for discount");
    expect(describeStep("TodoWrite", {}, cwd).running).toBe("Updating the task list");
    expect(describeStep("Mystery", null, cwd)).toEqual({ running: "Using Mystery", done: "Used Mystery" });
    expect(describeStep("mcp__acme_ai_Gmail__search_threads", {}, cwd).done).toBe("Used Gmail: search threads");
    expect(describeStep("mcp__notes__add-note", {}, cwd).done).toBe("Used Notes: add note");
    expect(describeStep("Agent", { description: "Count the files in Downloads" }, cwd).done).toBe("Asked a helper: Count the files in Downloads");
    expect(describeStep("Agent", {}, cwd).done).toBe("Asked a helper");
    expect(describeStep("CronList", {}, cwd).done).toBe("Checked the schedule");
    expect(describeStep("Bash", { command: "x".repeat(300) }, cwd).done.length).toBeLessThan(80);
  });
  test("a step that did not work says so plainly", () => {
    expect(describeFailure("Read", { file_path: "/Users/ana/shop/a.ts" }, "/Users/ana/shop")).toBe("Could not read a.ts");
    expect(describeFailure("Bash", { command: "npm run build" }, "/x")).toBe("The command failed: npm run build");
    expect(describeFailure("Edit", { file_path: "b.ts" }, "/x")).toBe("Could not change b.ts");
    expect(describeFailure("Grep", {}, "/x")).toBe("The search did not work");
    expect(describeFailure("Mystery", {}, "/x")).toBe("Could not use Mystery");
  });
  test("results worth a few words", () => {
    expect(stepTail("Read", {}, "a\nb\nc")).toBe("3 lines");
    expect(stepTail("Edit", { old_string: "a\nb", new_string: "c" }, "Edited")).toBe("1 line added, 2 removed");
    expect(stepTail("Bash", {}, "ok\n14 passed in 2s\n[exit 0]")).toBe("14 passed");
    expect(stepTail("Bash", {}, "boom\n[exit 2]")).toBe("failed, exit 2");
    expect(stepTail("Bash", {}, "done\n[exit 0]")).toBe("");
    expect(stepTail("Glob", {}, "a\nb")).toBe("2 files");
    expect(stepTail("Grep", {}, "No matches.")).toBe("no matches");
  });
});

describe("Bash output, old form and new", () => {
  test("the old form: a bare [exit N] on its own line, every time, even on success", () => {
    expect(parseBashOutput("one\ntwo\n[exit 0]")).toEqual({ lines: ["one", "two"], notes: [], exitCode: 0 });
    expect(parseBashOutput("boom\n[exit 2]")).toEqual({ lines: ["boom"], notes: [], exitCode: 2 });
    expect(bashFailed("boom\n[exit 2]")).toBe(true);
    expect(bashFailed("ok\n[exit 0]")).toBe(false);
  });
  test("the new form: [exit N: reason] only on failure, its reason kept as a quiet note, and a literal \"(no output)\" for an empty success", () => {
    expect(parseBashOutput("one\ntwo")).toEqual({ lines: ["one", "two"], notes: [] });
    expect(parseBashOutput("(no output)")).toEqual({ lines: [], notes: [] });
    expect(parseBashOutput("boom\n[exit 2: the build failed]")).toEqual({ lines: ["boom"], notes: ["[exit 2: the build failed]"], exitCode: 2 });
    expect(bashFailed("boom\n[exit 2: the build failed]")).toBe(true);
    expect(bashFailed("one\ntwo")).toBe(false);
    expect(bashFailed("(no output)")).toBe(false);
  });
  test("grep's exit 1 is an answer, not a failure: the reason is kept so a person reading the step sees it too", () => {
    expect(parseBashOutput("[exit 1: no matches, not a failure]")).toEqual({ lines: [], notes: ["[exit 1: no matches, not a failure]"], exitCode: 1 });
  });
  test("navvied's own notes (where it now runs, a background job) are taken apart from what the command printed, in either form", () => {
    expect(parseBashOutput("one\n[navvied: next commands start in src]\n[exit 0]")).toEqual({ lines: ["one"], notes: ["[navvied: next commands start in src]"], exitCode: 0 });
    expect(parseBashOutput("one\n[navvied: next commands still start in src, a cd outside the project lasts one command]")).toEqual({ lines: ["one"], notes: ["[navvied: next commands still start in src, a cd outside the project lasts one command]"] });
    expect(parseBashOutput("one\n[now in src]\n[exit 0]")).toEqual({ lines: ["one"], notes: ["[now in src]"], exitCode: 0 });
    expect(parseBashOutput("one\n[stays in .]")).toEqual({ lines: ["one"], notes: ["[stays in .]"] });
    expect(parseBashOutput("[still running as job1 after 3s without output: npm run dev]")).toEqual({ lines: [], notes: ["[still running as job1 after 3s without output: npm run dev]"] });
    expect(parseBashOutput("[job1 finished]\n[exit 0]")).toEqual({ lines: [], notes: ["[job1 finished]"], exitCode: 0 });
  });
  test("stepTail reads either form the same way", () => {
    expect(stepTail("Bash", {}, "boom\n[exit 2: the build failed]")).toBe("failed, exit 2");
    expect(stepTail("Bash", {}, "done")).toBe("");
    expect(stepTail("Bash", {}, "(no output)")).toBe("");
  });
});

describe("what an edit changed", () => {
  test("removed lines then added lines, numbered from where the change starts", () => {
    expect(diffRows("a\nb", "c", 41)).toEqual([{ kind: "del", line: 41, text: "a" }, { kind: "del", line: 42, text: "b" }, { kind: "add", line: 41, text: "c" }]);
    expect(diffRows("", "new", 3)).toEqual([{ kind: "add", line: 3, text: "new" }]);
    expect(diffRows("old", "", 3)).toEqual([{ kind: "del", line: 3, text: "old" }]);
  });
  test("a long change is cut and says how much is left", () => {
    const rows = diffRows("x\n".repeat(30).trimEnd(), "y", 1, 5);
    expect(rows).toHaveLength(6);
    expect(rows.at(-1)).toEqual({ kind: "more", line: 0, text: "26 more lines" });
  });
  test("the start line comes from what the tool reported", () => {
    expect(startLine("Edited /a.ts at line 41 (1 replacement).")).toBe(41);
    expect(startLine("Edited /a.ts (1 replacement).")).toBe(1);
  });
});
