import { describe, expect, test } from "bun:test";
import { MOST_NOTES, MOST_NOTE_BYTES, annotations } from "./support/ci-annotate.ts";

const failed = (name: string, message: string): string => `<testcase name="${name}" classname="" time="0.1" file="packages/a/test/a.test.ts"><failure type="AssertionError" message="${message}" /></testcase>`;
const COMPARED = "expect(received).toEqual(expected)&#10;&#10;  [&#10;-   &quot;check failed&quot;,&#10;-   &quot;&quot;,&#10;+   &quot;agent failed&quot;,&#10;+   &quot;spawn x ENOENT&quot;,&#10;  ]&#10;&#10;- Expected  - 2&#10;+ Received  + 2&#10;";
const textOf = (xml: string): string[] => annotations(`<testsuites>${xml}</testsuites>`).filter((line) => line.startsWith("::error")).map((line) => decodeURIComponent(line.slice(line.indexOf("::", 2) + 2)));

describe("a failure's note says what was expected and what came instead", () => {
  test("the lines that differ are kept, without the counting lines and the brackets around them", () => {
    expect(textOf(failed("compares", COMPARED))).toEqual(['packages/a/test/a.test.ts :: expect(received).toEqual(expected) :: - "check failed", - "", + "agent failed", + "spawn x ENOENT", :: compares']);
  });

  test("expected and received are kept for a plain comparison, a thrown error keeps its further lines but no stack, and tests that failed alike share one entry", () => {
    expect(textOf(failed("one", "expect(received).toBe(expected)&#10;&#10;Expected: 2&#10;Received: 1&#10;") + failed("two", "expect(received).toBe(expected)&#10;&#10;Expected: 2&#10;Received: 1&#10;") + failed("three", "boom: the reason&#10;the second line&#10;      at deep (x.ts:1:2)&#10;"))).toEqual(["packages/a/test/a.test.ts :: expect(received).toBe(expected) :: Expected: 2 Received: 1 :: one | two\npackages/a/test/a.test.ts :: boom: the reason :: the second line :: three"]);
  });

  test("a very long difference is cut, and when the details would push a name out they are left away so every name is there", () => {
    const long = (i: number): string => `expect(received).toBe(expected)&#10;&#10;Expected: ${i}&#10;Received: ${"x".repeat(2_000)}&#10;`;
    const one = textOf(failed("long", long(1)))[0]!;
    expect(Buffer.byteLength(one)).toBeLessThan(500);
    const many = textOf(Array.from({ length: 200 }, (_, i) => failed(`case ${i} of many`, long(i))).join(""));
    const all = many.join("\n");
    expect(many.length).toBeLessThanOrEqual(MOST_NOTES);
    for (const note of many) expect(Buffer.byteLength(note)).toBeLessThanOrEqual(MOST_NOTE_BYTES);
    expect(all.match(/case \d+ of many/g)).toHaveLength(200);
    expect(all).not.toContain("Received:");
  });
});
