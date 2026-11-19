import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Markdown, highlight } from "../src/markdown.ts";
import { resolveTheme, setTheme } from "../src/theme.ts";

beforeAll(() => setTheme(resolveTheme({ theme: "dark" }, { COLORTERM: "truecolor" })));
/** The theme is shared by every test file, so it is put back for the ones that run after this one. */
afterAll(() => setTheme(resolveTheme(null, {})));
const strip = (s: string): string => s.replace(/\u001b\[[0-9;]*m/g, "");
const run = (text: string, color = false): string[] => {
  const md = new Markdown(color, () => 60);
  return [...text.split("\n").flatMap((l) => md.push(l)), ...md.flush()];
};

describe("the answer as it is shown", () => {
  test("headings lose their marks, lists get markers, and everything sits two columns in", () => {
    expect(run("# Title\n\nText with `code` and **bold**.\n\n1. one\n2) two\n- a\n  * nested")).toEqual([
      "  Title", "  ", "  Text with code and bold.", "  ", "  1  one", "  2  two", "  •  a", "    •  nested",
    ]);
  });
  test("a fenced block shows its language, then each line, and the fence marks disappear", () => {
    expect(run("before\n```ts\nconst a = 1;\n```\nafter")).toEqual(["  before", "  ts", "     const a = 1;", "  after"]);
    expect(run("```\nplain\n```")).toEqual(["  text", "     plain"]);
  });
  test("a fence that never closes keeps showing code, and a ``` inside the code with a language is still code", () => {
    expect(run("```py\nx = 1")).toEqual(["  py", "     x = 1"]);
  });
  test("a table is collected and shown with aligned columns and a rule under the header", () => {
    const out = run("| What | Design A |\n|---|---|\n| Header | Logo on the left |\n| Buttons | Rounded |\nafter");
    expect(out).toEqual(["  What      Design A", "  ──────────────────────────", "  Header    Logo on the left", "  Buttons   Rounded", "  after"]);
  });
  test("a table at the very end is shown when the text ends", () => {
    expect(run("| a | b |\n|--|--|\n| 1 | 2 |")).toEqual(["  a   b", "  ─────", "  1   2"]);
  });
  test("quotes and rules", () => {
    expect(run("> quoted\n---")[0]).toBe("  ▌ quoted");
    expect(run("---")[0]).toMatch(/^ {2}─{8,}$/);
  });
  test("with colour, code sits in a tinted box padded to the width, and prose marks use the accent", () => {
    const [label, row] = run("```js\nconst x = 'a'; // note\n```", true);
    expect(strip(label!)).toBe("  js");
    expect(row).toContain("\u001b[48;2;36;36;46m");
    expect(strip(row!).length).toBe(60 - 2);
    expect(strip(row!).trimEnd()).toBe("     const x = 'a'; // note");
    expect(run("**bold** and `code`", true)[0]).toContain("\u001b[1m");
  });
  test("the highlighter colours comments, strings, numbers and keywords, and leaves other words alone", () => {
    const out = highlight("const total = add(1, 'a'); // sum", true);
    expect(strip(out)).toBe("const total = add(1, 'a'); // sum");
    expect(out).not.toBe(strip(out));
    expect(highlight("plain words", false)).toBe("plain words");
    expect(strip(highlight("# comment only", true))).toBe("# comment only");
    expect(highlight("x = y", true)).toBe("x = y");
  });
});
