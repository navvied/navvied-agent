import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MOST_NOTES, MOST_NOTE_BYTES, annotations, cases } from "./support/ci-annotate.ts";

const report = `<?xml version="1.0"?><testsuites>
<testsuite name="a.test.ts" file="a.test.ts">
<testsuite name="suite one" file="a.test.ts" line="2">
<testcase name="ok" classname="suite one" time="0.01" file="a.test.ts" line="4" />
<testcase name="(unnamed)" classname="suite one" time="5.00172" file="a.test.ts" assertions="0"><failure type="TimeoutError" message="test timed out" /></testcase>
<testcase name="slow but fine" classname="suite one" time="3.5" file="a.test.ts" />
</testsuite>
<testcase name="a &lt; b: c, d" classname="" time="0.2" file="packages/x/y.test.ts"><failure type="AssertionError" message="Expected: 2&#10;Received: 1">trace</failure></testcase>
</testsuite></testsuites>`;

describe("the test report as annotations", () => {
  test("reads every test case with its file, group, time and failure", () => {
    expect(cases(report).map((c) => [c.name, c.suite, c.file, c.failure])).toEqual([
      ["ok", "suite one", "a.test.ts", undefined],
      ["(unnamed)", "suite one", "a.test.ts", "test timed out"],
      ["slow but fine", "suite one", "a.test.ts", undefined],
      ["a < b: c, d", "", "packages/x/y.test.ts", "Expected: 2\nReceived: 1"],
    ]);
  });

  const failing = (n: number, why: (i: number) => string, file: (i: number) => string = (i) => `D:\\a\\repo\\repo\\packages\\a\\test\\f${i % 7}.test.ts`): string => `<testsuites>${Array.from({ length: n }, (_, i) => `<testcase name="case ${i} of the thing under test" classname="a long group of tests" time="0.1" file="${file(i)}"><failure type="AssertionError" message="${why(i)}" /></testcase>`).join("")}</testsuites>`;
  const notes = (xml: string): { title: string; message: string }[] => annotations(xml).filter((l) => l.startsWith("::error ")).map((l) => { const [, title = "", message = ""] = /^::error title=(.*?)::(.*)$/.exec(l)!; return { title: title.replaceAll("%3A", ":").replaceAll("%2C", ","), message: message.replaceAll("%0A", "\n").replaceAll("%25", "%") }; });

  test("failures are listed in errors of their own, grouped by file and reason, with short paths; slow ones stay warnings", () => {
    expect(annotations(report)).toEqual([
      '::error title=2 failed tests::a.test.ts :: test timed out :: a hook of "suite one"%0Apackages/x/y.test.ts :: Expected: 2 :: a < b: c, d',
      "::warning file=a.test.ts,title=slow%3A suite one > slow but fine::took 3.5 s",
    ]);
    expect(notes(failing(3, () => "turn timed out", () => "/home/r/work/x/x/packages/engine/test/e.test.ts"))[0]!.message).toBe("engine/test/e.test.ts :: turn timed out :: " + [0, 1, 2].map((i) => `a long group of tests > case ${i} of the thing under test`).join(" | "));
  });

  test("no note is longer than what the page keeps of one, so a list is split into numbered notes and each failure is in one", () => {
    const made = notes(failing(65, (i) => `reason number ${i} ${"y".repeat(300)}`));
    expect(made.length).toBeGreaterThan(1);
    expect(made.length).toBeLessThanOrEqual(MOST_NOTES);
    made.forEach((note, at) => {
      expect(Buffer.byteLength(note.message)).toBeLessThanOrEqual(MOST_NOTE_BYTES);
      expect(note.title).toBe(`65 failed tests (${at + 1} of ${made.length})`);
    });
    const all = made.map((n) => n.message).join("\n");
    for (let i = 0; i < 65; i++) expect(all).toContain(`case ${i} of`);
  });

  test("more failures than all the notes hold are counted, never silently dropped", () => {
    const made = notes(failing(900, (i) => `reason number ${i} ${"y".repeat(300)}`));
    expect(made).toHaveLength(MOST_NOTES);
    for (const note of made) expect(Buffer.byteLength(note.message)).toBeLessThanOrEqual(MOST_NOTE_BYTES);
    const named = (made.map((n) => n.message).join("\n").match(/case \d+ of/g) ?? []).length;
    expect(made.at(-1)!.message).toEndWith(`and ${900 - named} more that did not fit`);
  });

  test("the workflow prints the list in a step of its own, so the test runner's own notes cannot use up the room for it", () => {
    const workflow = readFileSync(join(import.meta.dir, "../../../.github/workflows/ci.yml"), "utf8");
    const steps = workflow.split(/\n {6}- /);
    const running = steps.find((s) => s.includes("bun test packages"))!;
    const naming = steps.find((s) => s.includes("ci-annotate.ts"))!;
    expect(running).not.toContain("ci-annotate.ts");
    expect(naming).toContain("if: ${{ !cancelled() }}");
    expect(steps.indexOf(naming)).toBeGreaterThan(steps.indexOf(running));
  });

  test("a clean report has nothing to say", () => {
    expect(annotations('<testsuites><testcase name="x" classname="" time="0.1" file="a.ts" /></testsuites>')).toEqual([]);
  });
});
