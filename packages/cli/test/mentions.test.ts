import { describe, expect, test, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { expandMentions, extractAttachments, previewChips } from "../src/mentions.ts";

const dirs: string[] = [];
function project(files: Record<string, Buffer | string>): string {
  const d = mkdtempSync(join(tmpdir(), "navvied-mentions-"));
  dirs.push(d);
  for (const [name, body] of Object.entries(files)) { mkdirSync(join(d, name, ".."), { recursive: true }); writeFileSync(join(d, name), body); }
  return d;
}
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** The real PNG signature, padded with a null byte so it is seen as binary the same way a real file's header would be. */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
/** A real PDF header is enough for classifyFile to call it a PDF. */
const PDF = Buffer.from("%PDF-1.4\n%%EOF");
/** Binary, but no signature classifyFile knows: refused. */
const unknown = (tag: string): Buffer => Buffer.from([0x00, 0x01, 0x02, ...Buffer.from(tag)]);

/** A zip made by hand, the same way `@navvied/protocol`'s own tests build one, so an xlsx classifies for real. */
function zip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [], central: Buffer[] = [];
  let offset = 0, i = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text), packed = i++ % 2 ? deflateRawSync(raw) : raw, method = packed === raw ? 0 : 8, n = Buffer.from(name);
    const head = Buffer.alloc(30); head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(method, 8); head.writeUInt32LE(packed.length, 18); head.writeUInt32LE(raw.length, 22); head.writeUInt16LE(n.length, 26);
    const entry = Buffer.alloc(46); entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(method, 10); entry.writeUInt32LE(packed.length, 20); entry.writeUInt32LE(raw.length, 24); entry.writeUInt16LE(n.length, 28); entry.writeUInt32LE(offset, 42);
    locals.push(head, n, packed); central.push(entry, n);
    offset += 30 + n.length + packed.length;
  }
  const dir = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}
const XLSX = zip({ "xl/workbook.xml": "<x/>" });

describe("expandMentions", () => {
  test("a text file is inlined, a binary one is left alone", () => {
    const cwd = project({ "notes.md": "hello\nworld", "photo.png": PNG });
    const out = expandMentions("look at @notes.md and @photo.png", cwd);
    expect(out).toContain("[File notes.md]\nhello\nworld");
    expect(out).not.toContain("[File photo.png]");
  });
});

describe("extractAttachments", () => {
  test("a picture goes in images, base64, taken out of the text", () => {
    const cwd = project({ "photo.png": PNG });
    const r = extractAttachments("look at @photo.png please", cwd);
    expect(r.images).toEqual([{ mime: "image/png", data: PNG.toString("base64") }]);
    expect(r.files).toEqual([]);
    expect(r.text).toBe("look at please");
    expect(r.notes).toEqual(["Attached photo.png."]);
  });

  test("a PDF or a document goes in files, by its content", () => {
    const cwd = project({ "report.pdf": PDF, "sheet.xlsx": XLSX });
    const r = extractAttachments("@report.pdf and @sheet.xlsx", cwd);
    expect(r.files.map((f) => f.name)).toEqual(["report.pdf", "sheet.xlsx"]);
    expect(r.images).toEqual([]);
    expect(r.text.trim()).toBe("and");
  });

  test("a document is still attached by its content, even as plain ASCII with no byte that marks it binary", () => {
    const cwd = project({ "tiny.pdf": "%PDF-1.4\nall plain ASCII, nothing that looks binary\n%%EOF" });
    const r = extractAttachments("@tiny.pdf", cwd);
    expect(r.files.map((f) => f.name)).toEqual(["tiny.pdf"]);
    expect(r.text.trim()).toBe("");
  });

  test("a kind classifyFile does not take is refused on the spot, in its own words", () => {
    const cwd = project({ "junk.pdf": unknown("not really a pdf") });
    const r = extractAttachments("@junk.pdf please", cwd);
    expect(r.images).toEqual([]);
    expect(r.files).toEqual([]);
    expect(r.notes).toEqual(["junk.pdf: This kind of file cannot be read."]);
    expect(r.text.trim()).toBe("please");
  });

  test("a plain text file is left for expandMentions, not attached", () => {
    const cwd = project({ "a.ts": "export const x = 1;" });
    const r = extractAttachments("@a.ts", cwd);
    expect(r.images).toEqual([]);
    expect(r.files).toEqual([]);
    expect(r.text).toBe("@a.ts");
  });

  test("past the limit, the rest are named in a note and left out of the message", () => {
    const files: Record<string, Buffer> = {};
    const mention = Array.from({ length: 9 }, (_, i) => { files[`p${i}.png`] = PNG; return `@p${i}.png`; }).join(" ");
    const cwd = project(files);
    const r = extractAttachments(mention, cwd);
    expect(r.images).toHaveLength(8);
    expect(r.notes.at(-1)).toBe("You can add up to 8 pictures and files to one message.");
    expect(r.text.trim()).toBe("");
  });

  test("too large is named and left out, too", () => {
    const big = Buffer.concat([PDF, Buffer.alloc(15 * 1024 * 1024)]);
    const cwd = project({ "huge.pdf": big });
    const r = extractAttachments("@huge.pdf", cwd);
    expect(r.files).toEqual([]);
    expect(r.notes).toEqual(["huge.pdf is larger than 15 MB."]);
    expect(r.text.trim()).toBe("");
  });

  test("a mention that is not a real file is left as plain text, for expandMentions or the model to make of it what it can", () => {
    const cwd = project({});
    const r = extractAttachments("@nothing-here.pdf", cwd);
    expect(r.images).toEqual([]);
    expect(r.files).toEqual([]);
    expect(r.text).toBe("@nothing-here.pdf");
  });
});

describe("previewChips", () => {
  test("every real file mentioned gets a chip, whatever its kind", () => {
    const cwd = project({ "photo.png": PNG, "report.pdf": PDF, "notes.md": "hi" });
    const chips = previewChips("@photo.png @report.pdf @notes.md and @nope.pdf", cwd);
    expect(chips).toEqual([
      { name: "photo.png", refused: false },
      { name: "report.pdf", refused: false },
      { name: "notes.md", refused: false },
    ]);
  });

  test("a file classifyFile refuses still gets a chip, marked so it can be shown crossed out", () => {
    const cwd = project({ "junk.pdf": unknown("not really a pdf") });
    const chips = previewChips("@junk.pdf", cwd);
    expect(chips).toEqual([{ name: "junk.pdf", refused: true }]);
  });

  test("nothing mentioned, nothing shown", () => {
    expect(previewChips("just a plain message", project({}))).toEqual([]);
  });
});
