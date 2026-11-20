import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import type { FileInput } from "@navvied/protocol";
import { receive, safeName } from "../src/attachments.ts";
import { PNG, b64, docxFile, odpFile, odsFile, odtFile, pdf, pptxFile, xlsxFile, zip } from "./make-files.ts";
import { stopAllJobs } from "../src/index.ts";
import { HOOK_MS, hook, removeTrees } from "../../protocol/test/support/cleanup.ts";

const made: string[] = [];
const folder = () => { const d = mkdtempSync(join(tmpdir(), "navvied-attach-")); made.push(d); return join(d, "session"); };
afterAll(hook("attachments removes what it made", async () => { await stopAllJobs(); await removeTrees(made); }), HOOK_MS);

const file = (name: string, bytes: Buffer | string, mime = "application/octet-stream"): FileInput => ({ name, mime, data: b64(bytes) });
const opts = (dir: string, more: Partial<Parameters<typeof receive>[1]> = {}) => ({ dir, budget: 20_000, readsPdf: false, ...more });
const textPdf = (...pages: string[]) => pdf(pages.map((t) => ({ content: `BT /F1 12 Tf (${t}) Tj ET` })));
const scanned = () => pdf([{ content: "0 0 m 10 10 l S" }, { content: "0 0 m 20 20 l S" }]);

describe("names of saved files", () => {
  test("a name is made safe and carries the extension of its content", () => {
    expect(safeName("../../etc/passwd")).toBe("passwd");
    expect(safeName("C:\\Users\\me\\report final?.pdf", ".pdf")).toBe("report final_.pdf");
    expect(safeName("scan", ".pdf")).toBe("scan.pdf");
    expect(safeName("notes.txt", ".docx")).toBe("notes.docx");
    expect(safeName("..hidden")).toBe("hidden");
    expect(safeName("   ")).toBe("file");
    expect(safeName("日本語.txt")).toBe("日本語.txt");
  });
});

describe("files are saved and described to the model", () => {
  test("a PDF: saved with a .pdf name whatever it was called, pages counted, its text under one line that says where it is", () => {
    const dir = folder();
    const r = receive([file("report.png", textPdf("Quarterly numbers", "Second page"))], opts(dir));
    const path = join(dir, "report.pdf");
    expect(existsSync(path)).toBe(true);
    expect(r.notes).toEqual([{ name: "report.png", kind: "pdf", pages: 2 }]);
    expect(r.text).toBe(`attached: report.png (2 pages) saved at ${path}\n--- Page 1 ---\nQuarterly numbers\n\n--- Page 2 ---\nSecond page`);
    expect(r.parts).toEqual([]);
  });

  test("the original PDF goes along only where the service reads PDFs, and not past a hundred pages", () => {
    const bytes = textPdf("a");
    const dir = folder();
    expect(receive([file("a.pdf", bytes)], opts(dir, { readsPdf: true })).parts).toEqual([{ type: "file", name: "a.pdf", mime: "application/pdf", data: b64(bytes) }]);
    expect(receive([file("b.pdf", bytes)], opts(dir, { readsPdf: false })).parts).toEqual([]);
    const long = pdf(Array.from({ length: 101 }, () => ({ content: "BT (x) Tj ET" })));
    expect(receive([file("long.pdf", long)], opts(dir, { readsPdf: true })).parts).toEqual([]);
  });

  test("a scanned PDF says so, is still saved, and still goes native where the service can look at it", () => {
    const dir = folder();
    const r = receive([file("scan.pdf", scanned())], opts(dir, { readsPdf: true }));
    expect(r.notes).toEqual([{ name: "scan.pdf", kind: "pdf", pages: 2, note: "no text in this PDF (scanned pages)" }]);
    expect(r.text).toBe(`attached: scan.pdf (2 pages) saved at ${join(dir, "scan.pdf")}. no text in this PDF (scanned pages)`);
    expect(r.parts).toHaveLength(1);
  });

  test("Word, PowerPoint, Excel and OpenDocument files give their text; slides count as pages", () => {
    const dir = folder();
    const r = receive([file("a.bin", docxFile("Hello", "World")), file("deck", pptxFile("One", "Two")), file("t.dat", xlsxFile()), file("o.txt", odtFile()), file("s", odsFile()), file("p", odpFile())], opts(dir));
    expect(r.notes.map((n) => [n.kind, n.pages])).toEqual([["document", undefined], ["document", 2], ["document", undefined], ["document", undefined], ["document", undefined], ["document", 2]]);
    expect(readdirSync(dir).sort()).toEqual(["a.docx", "deck.pptx", "o.odt", "p.odp", "s.ods", "t.xlsx"]);
    expect(r.text).toContain("(document) saved at");
    expect(r.text).toContain("Hello\nWorld");
    expect(r.text).toContain("--- Slide 1 ---\nOne\n\n--- Slide 2 ---\nTwo");
    expect(r.text).toContain("--- Sheet: Data ---\nItem\tQty\nnut\t7");
    expect(r.text).toContain("Title\nOne  two\tthree\na | b\nLast");
    expect(r.text).toContain("--- Sheet: Sheet1 ---\nx\t\t\ty");
    expect(r.text).toContain("--- Slide 1 ---\nFirst\n\n--- Slide 2 ---\nSecond");
  });

  test("a text file gives its text; a file with the same name is not overwritten", () => {
    const dir = folder();
    const r = receive([file("n.txt", "one\n"), file("n.txt", "two\n")], opts(dir));
    expect(readdirSync(dir).sort()).toEqual(["n (2).txt", "n.txt"]);
    expect(readFileSync(join(dir, "n.txt"), "utf8")).toBe("one\n");
    expect(r.text).toContain(`attached: n.txt (text) saved at ${join(dir, "n.txt")}\none\n`);
    expect(r.text).toContain(`saved at ${join(dir, "n (2).txt")}\ntwo`);
  });

  test("text longer than the share of the budget is cut at a line, and the model is told how to read the rest", () => {
    const dir = folder();
    const lines = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
    const r = receive([file("big.txt", lines)], opts(dir, { budget: 2000 }));
    expect(r.text.length).toBeLessThan(2300);
    expect(r.text).toMatch(/line \d+\n… \[\d+ more characters not shown: read the rest with Read on the path above, using offset and limit\]$/);
    expect(readFileSync(join(dir, "big.txt"), "utf8")).toBe(lines);
  });

  test("the budget is shared by the files that have text", () => {
    const dir = folder();
    const a = "a".repeat(5000), b = "b".repeat(5000);
    const r = receive([file("a.txt", a), file("b.txt", b), file("i.png", PNG)], opts(dir, { budget: 4000 }));
    expect(r.text.match(/a/g)!.length).toBeLessThan(2200);
    expect(r.text).toContain("bbbb");
    expect(r.parts).toEqual([{ type: "image", mime: "image/png", data: b64(PNG) }]);
  });

  test("a picture is sent as it is, and named by its content", () => {
    const dir = folder();
    const r = receive([file("photo.txt", PNG, "text/plain")], opts(dir));
    expect(r.notes).toEqual([{ name: "photo.txt", kind: "image" }]);
    expect(r.parts).toEqual([{ type: "image", mime: "image/png", data: b64(PNG) }]);
    expect(existsSync(join(dir, "photo.png"))).toBe(true);
    expect(r.text).toBe(`attached: photo.txt (image) saved at ${join(dir, "photo.png")}`);
  });

  test("a model that cannot see pictures is not sent the picture, but the file is kept and the model is told", () => {
    const dir = folder();
    const r = receive([file("photo.png", PNG), file("n.txt", "hi")], opts(dir, { vision: false }));
    expect(r.parts).toEqual([]);
    expect(r.blind).toBe(true);
    expect(r.notes[0]).toEqual({ name: "photo.png", kind: "image", note: "this model cannot see pictures" });
    expect(r.text).toContain("It is not shown to you: this model cannot see pictures.");
    expect(existsSync(join(dir, "photo.png"))).toBe(true);
    expect(r.notes[1]).toEqual({ name: "n.txt", kind: "text" });
  });

  test("a refused file is not saved, says why in one sentence, and does not stop the others", () => {
    const dir = folder();
    const video = Buffer.from("\0\0\0\x18ftypisom\0\0\0\0", "latin1");
    const r = receive([file("movie.mp4", video), file("fine.txt", "ok"), file("old.doc", Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0]))], opts(dir));
    expect(r.notes).toEqual([
      { name: "movie.mp4", kind: "refused", note: "Video files are not supported." },
      { name: "fine.txt", kind: "text" },
      { name: "old.doc", kind: "refused", note: expect.stringMatching(/save it as docx, pptx or xlsx/) as unknown as string },
    ]);
    expect(readdirSync(dir)).toEqual(["fine.txt"]);
    expect(r.text).toContain("not attached: movie.mp4. Video files are not supported.");
  });

  test("a damaged document and a password-protected PDF are refused with a reason, not an error", () => {
    const dir = folder();
    const broken = zip({ "word/document.xml": "<w:document/>" }).subarray(0, 40);
    const r = receive([file("x.docx", broken), file("locked.pdf", pdf([{ content: "BT (x) Tj ET" }], { encrypt: true })), file("empty.docx", zip({ "word/other.xml": "x", "word/document.xml": "" }))], opts(dir));
    expect(r.notes.map((n) => n.kind)).toEqual(["refused", "refused", "document"]);
    expect(r.notes[1]!.note).toBe("This PDF is protected with a password.");
    expect(readdirSync(dir)).toEqual(["empty.docx"]);
  });

  test("a folder that cannot be made refuses the file instead of failing the prompt", () => {
    const blocker = folder();
    receive([file("a.txt", "x")], opts(blocker));
    const r = receive([file("b.txt", "y")], opts(join(blocker, "a.txt", "inside")));
    expect(r.notes).toEqual([{ name: "b.txt", kind: "refused", note: "The file could not be saved on this computer." }]);
  });

  test("compressed Word content is read, not only stored", () => {
    const big = docxFile(...Array.from({ length: 200 }, (_, i) => `Paragraph number ${i}`));
    const dir = folder();
    expect(deflateSync(big).length).toBeGreaterThan(0);
    expect(receive([file("big.docx", big)], opts(dir, { budget: 100_000 })).text).toContain("Paragraph number 199");
  });
});
