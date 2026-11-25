import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOOK_MS, hook } from "../../protocol/test/support/cleanup.ts";
import { pageList } from "../src/tools/read.ts";
import { pdf } from "./make-files.ts";
import { cleanFiles, conversation, tool, workdir } from "./files-support.ts";

afterAll(hook("files-read removes what it made", cleanFiles), HOOK_MS);
const read = tool("Read");

// A 1x1 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

describe("Read of a picture", () => {
  test("is handed to the model as a picture part, with a line that says so", async () => {
    const d = workdir();
    writeFileSync(join(d, "chart.png"), PNG);
    const c = conversation(d, { vision: true });
    const out = await read.run({ file_path: "chart.png" }, c);
    expect(out).toMatch(/is a picture \(image\/png, \d+ bytes\), shown to you/);
    expect(c.shown).toEqual([{ type: "image", mime: "image/png", data: PNG.toString("base64") }]);
  });
  test("by its bytes, whatever its name says", async () => {
    const d = workdir();
    writeFileSync(join(d, "shot"), PNG);
    const c = conversation(d);
    await read.run({ file_path: "shot" }, c);
    expect(c.shown).toHaveLength(1);
  });
  test("a model that cannot see pictures is told so and is shown nothing", async () => {
    const d = workdir();
    writeFileSync(join(d, "chart.png"), PNG);
    const c = conversation(d, { vision: false });
    expect(await read.run({ file_path: "chart.png" }, c)).toMatch(/This model cannot see pictures/);
    expect(c.shown).toEqual([]);
  });
  test("a picture too large to send says what to do", async () => {
    const d = workdir();
    writeFileSync(join(d, "huge.png"), Buffer.concat([PNG, Buffer.alloc(13_000_000)]));
    expect(await read.run({ file_path: "huge.png" }, conversation(d, { vision: true }))).toMatch(/too large to show.*smaller copy/);
  });
  test("a file named .png that is not a picture is a binary file", async () => {
    const d = workdir();
    writeFileSync(join(d, "fake.png"), Buffer.from([1, 0, 2, 0]));
    expect(await read.run({ file_path: "fake.png" }, conversation(d, { vision: true }))).toMatch(/looks binary/);
  });
});

describe("Read of a PDF", () => {
  const pages = (n: number) => pdf(Array.from({ length: n }, (_, i) => ({ content: `BT /F1 12 Tf (text of page ${i + 1}) Tj ET` })));
  test("a short one is given whole, with its page count", async () => {
    const d = workdir();
    writeFileSync(join(d, "s.pdf"), pages(3));
    const out = await read.run({ file_path: "s.pdf" }, conversation(d));
    expect(out).toContain("PDF of 3 pages");
    expect(out).toContain("text of page 3");
  });
  test("a long one gives its first pages and says how to ask for the rest; pages picks a range", async () => {
    const d = workdir();
    writeFileSync(join(d, "l.pdf"), pages(30));
    const first = await read.run({ file_path: "l.pdf" }, conversation(d));
    expect(first).toContain("PDF of 30 pages; pages 1-10 follow, 20 more not shown: ask for them with pages \"11-30\"");
    expect(first).toContain("text of page 10");
    expect(first).not.toContain("text of page 11");
    const part = await read.run({ file_path: "l.pdf", pages: "12-13" }, conversation(d));
    expect(part).toContain("text of page 12");
    expect(part).toContain("text of page 13");
    expect(part).not.toContain("text of page 14");
  });
  test("pageList reads 3, 2-5, 4-, lists, and refuses what is outside the file or not a range", () => {
    expect(pageList("3", 10)).toEqual([3]);
    expect(pageList("2-4", 10)).toEqual([2, 3, 4]);
    expect(pageList("8-", 10)).toEqual([8, 9, 10]);
    expect(pageList("1-2,5", 10)).toEqual([1, 2, 5]);
    expect(pageList("20", 10)).toMatch(/outside it/);
    expect(pageList("abc", 10)).toMatch(/not like/);
  });
});

describe("Read of a notebook", () => {
  test("shows the cells with their numbers, ids and outputs", async () => {
    const d = workdir();
    const nb = { nbformat: 4, nbformat_minor: 5, cells: [
      { cell_type: "markdown", id: "m1", metadata: {}, source: ["# Title\n", "text"] },
      { cell_type: "code", id: "c1", metadata: {}, execution_count: 1, source: ["print(1+1)"], outputs: [{ output_type: "stream", name: "stdout", text: ["2\n"] }, { output_type: "display_data", data: { "image/png": "AAAA" } }] },
    ] };
    writeFileSync(join(d, "a.ipynb"), JSON.stringify(nb));
    const out = await read.run({ file_path: "a.ipynb" }, conversation(d));
    expect(out).toContain("# cell 0 [markdown] id=m1");
    expect(out).toContain("# cell 1 [code] id=c1");
    expect(out).toMatch(/print\(1\+1\)\n +\d+\t\[output\]\n +\d+\t2\n/);
    expect(out).toContain("[image/png output not shown]");
  });
});

describe("Read of text", () => {
  test("a byte-order mark is not shown, UTF-16 is decoded, and CRLF lines are shown as lines", async () => {
    const d = workdir();
    writeFileSync(join(d, "bom.txt"), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("héllo\r\nworld\r\n")]));
    writeFileSync(join(d, "u16.txt"), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("héllo\nworld\n", "utf16le")]));
    const c = conversation(d);
    expect(await read.run({ file_path: "bom.txt" }, c)).toBe("     1\théllo\n     2\tworld");
    expect(await read.run({ file_path: "u16.txt" }, c)).toBe("     1\théllo\n     2\tworld");
  });
  test("an empty file and an offset past the end are said in words", async () => {
    const d = workdir();
    writeFileSync(join(d, "e.txt"), "");
    writeFileSync(join(d, "f.txt"), "a\nb\n");
    const c = conversation(d);
    expect(await read.run({ file_path: "e.txt" }, c)).toBe("The file exists but is empty.");
    expect(await read.run({ file_path: "f.txt", offset: 9 }, c)).toMatch(/offset 9 is past the end/);
  });
  test("a device file is not read", async () => {
    expect(await read.run({ file_path: "/dev/zero" }, conversation(workdir()))).toMatch(/not a regular file/);
  });
  test("a file over 5 MB is read in pages, from the line asked for, and says where to go on", async () => {
    const d = workdir();
    const line = (i: number): string => `line ${i} ${"x".repeat(90)}\n`;
    writeFileSync(join(d, "big.log"), Array.from({ length: 60_000 }, (_, i) => line(i + 1)).join(""));
    const c = conversation(d);
    const first = await read.run({ file_path: "big.log", limit: 3 }, c);
    expect(first).toContain("     1\tline 1 ");
    expect(first).toContain("     3\tline 3 ");
    expect(first).toContain("more lines follow — raise offset to 4");
    const deep = await read.run({ file_path: "big.log", offset: 59_998, limit: 10 }, c);
    expect(deep).toContain(" 59998\tline 59998 ");
    expect(deep).toContain(" 60000\tline 60000 ");
    expect(deep).not.toContain("more lines follow");
    expect(await read.run({ file_path: "big.log", offset: 70_000 }, c)).toMatch(/fewer than 70000 lines/);
  });
  test("a big binary file is refused", async () => {
    const d = workdir();
    writeFileSync(join(d, "big.bin"), Buffer.alloc(5_100_000));
    expect(await read.run({ file_path: "big.bin" }, conversation(d))).toMatch(/looks binary/);
  });
});

describe("what a conversation has read", () => {
  test("the same part read again, unchanged, is answered with a stub; a change or another part is read in full", async () => {
    const d = workdir();
    const f = join(d, "a.txt");
    writeFileSync(f, "one\ntwo\nthree\n");
    const c = conversation(d);
    expect(await read.run({ file_path: "a.txt" }, c)).toContain("two");
    expect(await read.run({ file_path: "a.txt" }, c)).toMatch(/is unchanged since you read it \(lines 1-3\)/);
    expect(await read.run({ file_path: "a.txt", offset: 2 }, c)).toContain("two");
    writeFileSync(f, "one\nTWO\nthree\n");
    utimesSync(f, new Date(), new Date(Date.now() + 5000));
    expect(await read.run({ file_path: "a.txt", offset: 2 }, c)).toContain("TWO");
  });
  test("after the conversation was summarised the stub is not given but the file stays known", async () => {
    const d = workdir();
    writeFileSync(join(d, "a.txt"), "one\n");
    const c = conversation(d);
    await read.run({ file_path: "a.txt" }, c);
    c.files!.forgetShown();
    expect(await read.run({ file_path: "a.txt" }, c)).toContain("one");
    expect(c.files!.get(join(d, "a.txt"))).toBeDefined();
  });
  test("a folder is not read, and a path outside a confined conversation is refused", async () => {
    const d = workdir();
    mkdirSync(join(d, "sub"));
    expect(await read.run({ file_path: "sub" }, conversation(d))).toMatch(/is a directory/);
    await expect(read.run({ file_path: "/etc/hostname" }, conversation(d, { root: d }))).rejects.toThrow(/outside the folder/);
  });
});
