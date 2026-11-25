import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Media } from "../src/index.ts";
import { sides } from "../src/media/fit.ts";
import { applyChange } from "../src/tools/edit-text.ts";
import { printedFiles } from "../src/tools/shell-reads.ts";
import { cleanFiles, conversation, tool, workdir } from "./files-support.ts";
import { pdf } from "./make-files.ts";
import { PNG, program } from "./media-support.ts";

afterAll(cleanFiles);
const posix = process.platform !== "win32";
const read = tool("Read"), edit = tool("Edit"), bash = tool("Bash");
const doc = (n: number): Buffer => pdf(Array.from({ length: n }, (_, i) => ({ content: `BT /F1 12 Tf (text of page ${i + 1}) Tj ET` })));
const JPEG = "printf '\\377\\330\\377\\340junk'";

describe("Read of a PDF with pages, for a model that sees", () => {
  test.skipIf(!posix)("pdftoppm draws the asked pages as pictures, sized to 1,568 px; the text is still given", async () => {
    const d = workdir(), log = join(d, "args.txt");
    const pdftoppm = program(d, "pdftoppm", `echo "$@" >> ${log}\nfor last; do :; done\n${JPEG} > "$last.jpg"`);
    writeFileSync(join(d, "a.pdf"), doc(5));
    const c = conversation(d, { media: new Media({ pdftoppm }) });
    const out = await read.run({ file_path: "a.pdf", pages: "2-3" }, c);
    expect(out).toContain("text of page 2");
    expect(out).toContain("Pages 2, 3 are shown to you as pictures in the next message (sent by this tool, not written by the person).");
    expect(c.shown.map((p) => p.type)).toEqual(["image", "image"]);
    const calls = readFileSync(log, "utf8").trim().split("\n");
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("-jpeg");
    expect(calls[0]).toContain("-scale-to 1568");
    expect(calls[0]).toContain("-f 2 -l 2");
  });

  test.skipIf(!posix)("without pages nothing is drawn, and a text-only model gets the text as before", async () => {
    const d = workdir(), log = join(d, "args.txt");
    const pdftoppm = program(d, "pdftoppm", `echo run >> ${log}\nfor last; do :; done\n${JPEG} > "$last.jpg"`);
    writeFileSync(join(d, "a.pdf"), doc(3));
    const media = new Media({ pdftoppm });
    const whole = conversation(d, { media });
    expect(await read.run({ file_path: "a.pdf" }, whole)).not.toMatch(/shown to you|need/);
    const blind = conversation(d, { media, vision: false });
    const out = await read.run({ file_path: "a.pdf", pages: "1" }, blind);
    expect(out).toContain("text of page 1");
    expect(out).not.toMatch(/shown to you|Page images/);
    expect(blind.shown).toEqual([]);
    expect(() => readFileSync(log)).toThrow();
  });

  test("with no program the text comes with one plain line, and nothing is claimed seen", async () => {
    const d = workdir();
    writeFileSync(join(d, "a.pdf"), doc(2));
    const c = conversation(d, { media: new Media({ which: () => undefined }) });
    const out = await read.run({ file_path: "a.pdf", pages: "2" }, c);
    expect(out).toContain("text of page 2");
    expect(out.split("\n").filter((l) => l.startsWith("Page images need"))).toEqual(["Page images need pdftoppm, mutool or gs on this computer; none was found."]);
    expect(out).not.toMatch(/shown to you/);
    expect(c.shown).toEqual([]);
  });

  test.skipIf(!posix)("mutool and gs are used when pdftoppm is missing, in that order, without a shell", async () => {
    const d = workdir();
    const mutool = program(d, "mutool", `while [ $# -gt 0 ]; do [ "$1" = "-o" ] && o="$2"; shift; done\nprintf '\\211PNG\\r\\n\\032\\n' > "$o"; echo "$o" > ${join(d, "mutool.txt")}`);
    const gs = program(d, "gs", `for a; do case "$a" in -sOutputFile=*) o="\${a#-sOutputFile=}";; esac; done\n${JPEG} > "$o"`);
    writeFileSync(join(d, "a.pdf"), doc(2));
    const first = conversation(d, { media: new Media({ which: (n) => ({ mutool, gs })[n as "mutool"] }) });
    expect(await read.run({ file_path: "a.pdf", pages: "1" }, first)).toContain("Page 1 is shown to you as a picture");
    expect(readFileSync(join(d, "mutool.txt"), "utf8")).toMatch(/page-1\.png/);
    const second = conversation(d, { media: new Media({ which: (n) => (n === "gs" ? gs : undefined) }) });
    expect(await read.run({ file_path: "a.pdf", pages: "2" }, second)).toContain("Page 2 is shown to you as a picture");
    expect(second.shown).toHaveLength(1);
  });

  test.skipIf(!posix)("at most 8 pages are drawn per call and the rest is said; a page that fails is named, the others are still shown", async () => {
    const d = workdir();
    const pdftoppm = program(d, "pdftoppm", `for a; do [ "$a" = 3 ] && { echo "bad page" >&2; exit 1; }; done\nfor last; do :; done\n${JPEG} > "$last.jpg"`);
    writeFileSync(join(d, "a.pdf"), doc(12));
    const c = conversation(d, { media: new Media({ pdftoppm }) });
    const out = await read.run({ file_path: "a.pdf", pages: "1-12" }, c);
    expect(c.shown).toHaveLength(7);
    expect(out).toContain("Only the first 8 pages are drawn per call; ask for the rest from page 9.");
    expect(out).toContain("Page 3 could not be drawn: bad page");
    expect(out).toContain("Pages 1, 2, 4, 5, 6, 7, 8 are shown");
  });

  test.skipIf(!posix)("a page too heavy to show is not sent", async () => {
    const d = workdir();
    const pdftoppm = program(d, "pdftoppm", `for last; do :; done\n${JPEG} > "$last.jpg"\nhead -c 3000000 /dev/zero >> "$last.jpg"`);
    writeFileSync(join(d, "a.pdf"), doc(1));
    const c = conversation(d, { media: new Media({ pdftoppm, which: () => undefined }) });
    const out = await read.run({ file_path: "a.pdf", pages: "1" }, c);
    expect(out).toContain("Page 1 is too heavy to show");
    expect(c.shown).toEqual([]);
  });
});

describe("one helper makes pictures smaller, for Read and for LookAt", () => {
  const big = (d: string): string => { const p = join(d, "wall.png"); writeFileSync(p, PNG); truncateSync(p, 2_000_000); return p; };

  test.skipIf(!posix)("Read downscales a large picture to a JPEG with ffmpeg, and ImageMagick when ffmpeg is missing", async () => {
    const d = workdir(), log = join(d, "shrink.txt");
    big(d);
    const ffmpeg = program(d, "ffmpeg", `echo "$@" > ${log}\nfor last; do :; done\nprintf jpg > "$last"`);
    const a = conversation(d, { media: new Media({ local: { ffmpeg } }) });
    expect(await read.run({ file_path: "wall.png" }, a)).toContain("made smaller");
    expect(a.shown[0]).toMatchObject({ type: "image", mime: "image/jpeg" });
    expect(readFileSync(log, "utf8")).toContain("min(1568,iw)");
    const magick = program(d, "magick", `echo "$@" > ${log}\nfor last; do :; done\nprintf jpg > "$last"`);
    const b = conversation(d, { media: new Media({ which: (n) => (n === "magick" ? magick : undefined) }) });
    expect(await read.run({ file_path: "wall.png" }, b)).toContain("made smaller");
    expect(readFileSync(log, "utf8")).toContain("1568x1568>");
  });

  test("a small picture, and a large one with no program, go as they are", async () => {
    const d = workdir();
    big(d);
    writeFileSync(join(d, "tiny.png"), PNG);
    const c = conversation(d, { media: new Media({ which: () => undefined }) });
    expect(await read.run({ file_path: "wall.png" }, c)).not.toContain("made smaller");
    expect(await read.run({ file_path: "tiny.png" }, c)).not.toContain("made smaller");
    expect(c.shown.map((p) => (p as { mime: string }).mime)).toEqual(["image/png", "image/png"]);
  });

  test("the sides of a PNG, a JPEG and a GIF are read from their first bytes", () => {
    const png = Buffer.alloc(32); Buffer.from([0x89, 0x50, 0x4e, 0x47]).copy(png); png.writeUInt32BE(3000, 16); png.writeUInt32BE(200, 20);
    const gif = Buffer.from("GIF89a\x20\x00\x10\x00....", "latin1");
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0x04, 0x00, 0x08, 0x00, 3, 0, 0, 0]);
    expect(sides(png)).toEqual({ w: 3000, h: 200 });
    expect(sides(gif)).toEqual({ w: 32, h: 16 });
    expect(sides(jpeg)).toEqual({ w: 2048, h: 1024 });
    expect(sides(Buffer.from("plain text, not a picture"))).toBeUndefined();
  });
});

describe("a command that only prints a file counts as a read of it", () => {
  const files = (cmd: string, d: string): string[] => printedFiles(cmd, d).map((f) => f.slice(d.length + 1));

  test("cat, head, tail and sed -n of plain files, and nothing that could write", () => {
    const d = workdir();
    for (const n of ["a.txt", "b.txt"]) writeFileSync(join(d, n), "x\n");
    expect(files("cat a.txt", d)).toEqual(["a.txt"]);
    expect(files("cat -n a.txt b.txt", d)).toEqual(["a.txt", "b.txt"]);
    expect(files("head -n 20 a.txt", d)).toEqual(["a.txt"]);
    expect(files("tail -5 a.txt", d)).toEqual(["a.txt"]);
    expect(files("sed -n '1,20p' a.txt", d)).toEqual(["a.txt"]);
    for (const no of ["cat a.txt > b.txt", "cat a.txt | tee b.txt", "cat a.txt; rm b.txt", "cat a.txt && rm b.txt", "sed -i s/x/y/ a.txt", "sed -n 's/x/y/p' a.txt", "tail -f a.txt", "cat", "cat -", "cat missing.txt", "cat *.txt", "cat $(echo a.txt)", "cat a.txt 2>x", "sudo cat a.txt", "sed -n '1,2p;w b.txt' a.txt"]) expect(printedFiles(no, d)).toEqual([]);
  });

  test.skipIf(!posix)("Edit after a whole cat needs no Read; after a cut cat, a failed one, or a changed file it does", async () => {
    const d = workdir();
    writeFileSync(join(d, "a.txt"), "alpha\nbeta\n");
    writeFileSync(join(d, "big.txt"), `${"line of text\n".repeat(5000)}needle\n`);
    const c = conversation(d);
    const change = (f: string, from: string): Promise<string> => edit.run({ file_path: f, old_string: from, new_string: "done" }, c);
    expect(await change("a.txt", "beta")).toContain("Read it first");
    expect(await bash.run({ command: "cat a.txt" }, c)).toContain("alpha");
    expect(await change("a.txt", "beta")).toContain("Edited");
    expect(readFileSync(join(d, "a.txt"), "utf8")).toBe("alpha\ndone\n");

    const cut = await bash.run({ command: "cat big.txt" }, c);
    expect(cut.includes("[the whole output is saved in")).toBe(true);
    expect(await change("big.txt", "needle")).toContain("Read it first");

    await bash.run({ command: "cat nothing.txt" }, c);
    writeFileSync(join(d, "late.txt"), "late\n");
    expect(await change("late.txt", "late")).toContain("Read it first");

    await bash.run({ command: "cat a.txt" }, c);
    writeFileSync(join(d, "a.txt"), "alpha\nother\n");
    expect(await change("a.txt", "other")).toMatch(/Edited|changed after you read it/);
  });

  test.skipIf(!posix)("a cat that fails on one of its files is not a read of the others", async () => {
    const d = workdir();
    writeFileSync(join(d, "k.txt"), "one\n");
    const c = conversation(d);
    await bash.run({ command: "cat k.txt nothing.txt" }, c);
    expect(await edit.run({ file_path: "k.txt", old_string: "one", new_string: "two" }, c)).toContain("Read it first");
  });
});

describe("Edit fuzzy steps: each only rewrites characters, and never guesses at what is similar", () => {
  const apply = (text: string, from: string, to = "NEW"): string => {
    const r = applyChange(text, { from, to, all: false });
    return "error" in r ? `error: ${r.error}` : `${r.text}|${r.note ?? ""}`;
  };

  test("runs of spaces and tabs inside a line are read as one", () => {
    expect(apply("let  x =\t1;\n", "let x = 1;")).toBe("NEW\n|matched with runs of spaces and tabs read as one space");
    expect(apply("a  b  c\n", "b c")).toBe("a  NEW\n|matched with runs of spaces and tabs read as one space");
    expect(apply("ab\n", "a b")).toMatch(/^error/);
    expect(apply("a-b\n", "a b")).toMatch(/^error/);
  });

  test("the ellipsis, the thin and wide spaces, and a long dash typed as two hyphens match", () => {
    expect(apply("wait… done\n", "wait... done")).toContain("NEW");
    expect(apply("a b c\n", "a b c")).toContain("NEW");
    expect(apply("one — two\n", "one -- two")).toContain("NEW");
    expect(apply("one — two\n", "one - two")).toContain("NEW");
    expect(apply("wait.. done\n", "wait… done")).toMatch(/^error/);
    expect(apply("one - two\n", "one — three")).toMatch(/^error/);
  });

  test("a match never starts or ends inside what one character became", () => {
    expect(apply("wait… done\n", "wait..")).toMatch(/^error/);
    expect(apply("wait… done\n", ".. done")).toMatch(/^error/);
  });

  test("lines match whatever the indentation, spacing and typographic marks; a different word does not", () => {
    const file = "  if (a  ==  “b”) {\n    run();\n  }\n";
    const r = applyChange(file, { from: 'if (a == "b") {\n  run();\n}', to: 'if (a == "c") {\n  run();\n}', all: false });
    expect("error" in r).toBe(false);
    if (!("error" in r)) { expect(r.text).toBe('  if (a == "c") {\n    run();\n  }\n'); expect(r.note).toContain("indentation"); }
    expect(apply(file, 'if (a == "b") {\n  walk();\n}')).toMatch(/^error/);
  });

  test("a changed file gets no fuzzy step at all, and an ambiguous fuzzy match is refused", () => {
    expect("error" in applyChange("a  b\n", { from: "a b", to: "c", all: false }, true)).toBe(true);
    expect(apply("a  b\na   b\n", "a b")).toContain("matches 2 places");
  });
});
