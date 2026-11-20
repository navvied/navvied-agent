import { describe, expect, test } from "bun:test";
import { annotations, cases } from "./support/ci-annotate.ts";

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

  test("a failed hook is named by its group and file, and a test by its own name; both carry how long they ran", () => {
    expect(annotations(report)).toEqual([
      '::error file=a.test.ts,title=a hook of "suite one" (5.0 s)::test timed out',
      "::error file=packages/x/y.test.ts,title=a < b%3A c%2C d (0.2 s)::Expected: 2%0AReceived: 1",
      "::warning file=a.test.ts,title=slow%3A suite one > slow but fine::took 3.5 s",
    ]);
  });

  test("a clean report has nothing to say", () => {
    expect(annotations('<testsuites><testcase name="x" classname="" time="0.1" file="a.ts" /></testsuites>')).toEqual([]);
  });
});
