import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MOST_MESSAGE, annotations, cases } from "./support/ci-annotate.ts";

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

  test("every failed test and hook is in ONE error, a line each with file, group, name and the first line of why; slow ones stay warnings", () => {
    expect(annotations(report)).toEqual([
      '::error title=2 failed tests::a.test.ts :: a hook of "suite one" (5.0 s) :: test timed out%0Apackages/x/y.test.ts :: a < b: c, d (0.2 s) :: Expected: 2',
      "::warning file=a.test.ts,title=slow%3A suite one > slow but fine::took 3.5 s",
    ]);
  });

  test("a hundred failures are still one error that names each of them, inside what one annotation can hold", () => {
    const many = Array.from({ length: 100 }, (_, i) => `<testcase name="case ${i} ${"x".repeat(80)}" classname="g" time="0.1" file="packages/a/test/f${i % 7}.test.ts"><failure type="AssertionError" message="${"y".repeat(500)}" /></testcase>`).join("");
    const lines = annotations(`<testsuites>${many}</testsuites>`);
    expect(lines).toHaveLength(1);
    for (let i = 0; i < 100; i++) expect(lines[0]).toContain(`case ${i} `);
    expect(lines[0]!.length).toBeLessThanOrEqual(MOST_MESSAGE);
  });

  test("more failures than fit are counted, never silently dropped", () => {
    const many = Array.from({ length: 2000 }, (_, i) => `<testcase name="case ${i} ${"x".repeat(80)}" classname="g" time="0.1" file="a.test.ts"><failure message="no" /></testcase>`).join("");
    const [line = ""] = annotations(`<testsuites>${many}</testsuites>`);
    expect(line.length).toBeLessThanOrEqual(MOST_MESSAGE);
    expect(line).toStartWith("::error title=2000 failed tests::");
    const named = line.split("%0A").filter((l) => l.includes("case ")).length;
    expect(line).toEndWith(`and ${2000 - named} more that did not fit`);
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
