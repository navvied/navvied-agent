import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync, deflateSync } from "node:zlib";
import { read } from "../src/tools/read.ts";
import { readDocument } from "../src/tools/documents.ts";

const dir = mkdtempSync(join(tmpdir(), "navvied-docs-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function crc32(b: Buffer): number { let c, crc = 0xffffffff; for (const byte of b) { c = (crc ^ byte) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ 0xffffffff) >>> 0; }

/** A zip file made by hand, with every second entry compressed, the way real office files mix them. */
function zip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [], central: Buffer[] = [];
  let offset = 0, i = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text), packed = i++ % 2 ? deflateRawSync(raw) : raw, method = packed === raw ? 0 : 8;
    const n = Buffer.from(name);
    const head = Buffer.alloc(30); head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(method, 8); head.writeUInt32LE(crc32(raw), 14); head.writeUInt32LE(packed.length, 18); head.writeUInt32LE(raw.length, 22); head.writeUInt16LE(n.length, 26);
    const entry = Buffer.alloc(46); entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(method, 10); entry.writeUInt32LE(crc32(raw), 16); entry.writeUInt32LE(packed.length, 20); entry.writeUInt32LE(raw.length, 24); entry.writeUInt16LE(n.length, 28); entry.writeUInt32LE(offset, 42);
    locals.push(head, n, packed); central.push(entry, n);
    offset += 30 + n.length + packed.length;
  }
  const dirBuf = Buffer.concat(central);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(dirBuf.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dirBuf, end]);
}

const docx = zip({
  "[Content_Types].xml": "<Types/>",
  "word/document.xml": `<w:document><w:body><w:p><w:pPr/><w:r><w:t>Release plan</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">Ship it &amp; </w:t></w:r><w:r><w:t>celebrate</w:t></w:r></w:p>
    <w:tbl><w:tr><w:tc><w:p><w:r><w:t>Name</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Owner</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>Login</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Zoe</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
    <w:p><w:r><w:t>The end</w:t></w:r></w:p></w:body></w:document>`,
});
const pptx = zip({
  "ppt/slides/slide2.xml": `<p:sld><a:p><a:r><a:t>Second slide</a:t></a:r></a:p></p:sld>`,
  "ppt/slides/slide1.xml": `<p:sld><a:p><a:r><a:t>Title</a:t></a:r></a:p><a:p><a:r><a:t>Sub</a:t></a:r><a:r><a:t>title</a:t></a:r></a:p></p:sld>`,
  "ppt/slides/slide10.xml": `<p:sld><a:p><a:r><a:t>Tenth</a:t></a:r></a:p></p:sld>`,
});
const xlsx = zip({
  "xl/workbook.xml": `<workbook><sheets><sheet name="Data" sheetId="1" r:id="rId1"/><sheet name="Notes" sheetId="2" r:id="rId2"/></sheets></workbook>`,
  "xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>`,
  "xl/sharedStrings.xml": `<sst><si><t>Item</t></si><si><t>Qty</t></si><si><r><t>Wid</t></r><r><t>get</t></r></si></sst>`,
  "xl/worksheets/sheet1.xml": `<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="C2"><v>42</v></c></row></sheetData></worksheet>`,
  "xl/worksheets/sheet2.xml": `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>a note</t></is></c></row></sheetData></worksheet>`,
});
const pdfWith = (stream: Buffer) => Buffer.concat([Buffer.from("%PDF-1.4\n1 0 obj\n<< /Length 0 >>\nstream\n", "latin1"), stream, Buffer.from("\nendstream\nendobj\n%%EOF\n", "latin1")]);

describe("reading documents", () => {
  test("a Word file gives its paragraphs and tables, with entities and joined runs read", () => {
    const r = readDocument("a.docx", docx);
    expect(r).toEqual({ ok: true, text: "Release plan\nShip it & celebrate\nName | Owner\nLogin | Zoe\nThe end" });
  });
  test("a PowerPoint file gives its slides in order, with the runs of a paragraph joined", () => {
    const r = readDocument("a.pptx", pptx);
    expect(r).toEqual({ ok: true, text: "--- Slide 1 ---\nTitle\nSubtitle\n\n--- Slide 2 ---\nSecond slide\n\n--- Slide 3 ---\nTenth" });
  });
  test("an Excel file gives each sheet as rows of tab-separated cells, shared strings, numbers and empty cells in place", () => {
    const r = readDocument("a.xlsx", xlsx);
    expect(r).toEqual({ ok: true, text: "--- Sheet: Data ---\nItem\tQty\nWidget\t\t42\n\n--- Sheet: Notes ---\na note" });
  });
  test("a PDF with text in a compressed or plain page stream is read without any program", () => {
    const page = "BT /F1 12 Tf 72 700 Td (Hello \\(PDF\\)) Tj 0 -14 Td [(Wor) -300 (ld)] TJ ET";
    for (const stream of [Buffer.from(page, "latin1"), deflateSync(Buffer.from(page, "latin1"))]) {
      const r = readDocument("a.pdf", pdfWith(stream));
      expect(r.ok && r.text).toContain("Hello (PDF)");
      expect(r.ok && r.text).toContain("Wor ld");
    }
  });
  test("a file that is not what its name says, and a PDF with no text, say so in plain words", () => {
    expect(readDocument("a.docx", Buffer.from("just text"))).toEqual({ ok: false, error: "this is not a document file (no zip directory)" });
    const empty = readDocument("a.pdf", pdfWith(Buffer.from("0 0 m 10 10 l S", "latin1")));
    expect(!empty.ok && empty.error).toContain("no text found");
    expect(!readDocument("a.docx", zip({ "other.xml": "<x/>" })).ok).toBe(true);
  });
});

describe("the Read tool", () => {
  test("reads a document as numbered lines like any file, and says what is wrong with one it cannot read", async () => {
    writeFileSync(join(dir, "plan.docx"), docx);
    writeFileSync(join(dir, "broken.xlsx"), "not a zip");
    const ctx = { cwd: dir, signal: new AbortController().signal, emit() {}, allowPrivateNetwork: false } as never;
    const ok = await read.run({ file_path: "plan.docx" }, ctx);
    expect(ok).toContain("     1\tRelease plan");
    expect(ok).toContain("     3\tName | Owner");
    expect(await read.run({ file_path: "broken.xlsx" }, ctx)).toContain("not a document file");
  });
});
