import { describe, expect, test } from "bun:test";
import { pdfPages } from "../src/tools/documents.ts";
import { pdfText } from "../src/tools/pdf.ts";
import { pdf } from "./make-files.ts";

describe("text from a PDF with no program", () => {
  test("pages come in page-tree order, one string each, with the strings of Tj, TJ, ' and \" read and lines kept apart", () => {
    const r = pdfText(pdf([
      { content: "BT /F1 12 Tf 72 700 Td (Page one \\(a\\)) Tj 0 -14 Td [(Wor) -300 (ld)] TJ ET" },
      { content: "BT /F1 12 Tf (Second) Tj T* (line) Tj ET BT (apostrophe) ' ET" },
    ]));
    expect(r.pages).toEqual(["Page one (a)\nWor ld", "Second\nline\napostrophe"]);
  });

  test("what the page puts side by side stays on one line, with a space only where there is a gap; a move down is a new line", () => {
    const content = [
      "BT /F1 8 Tf 1 0 0 1 36 50 Tm (N) Tj ET BT /F1 6 Tf 1 0 0 1 40 50 Tm (VIDIA) Tj ET",
      "BT /F1 10 Tf 1 0 0 1 36 700 Tm (Hello) Tj 1 0 0 1 100 700 Tm (World) Tj 1 0 0 1 36 680 Tm (Next) Tj ET",
      "BT /F1 10 Tf 36 600 Td (Left) Tj 70 0 Td (Right) Tj 0 -12 Td (Below) Tj ET",
    ];
    expect(pdfText(pdf(content.map((c) => ({ content: c })))).pages).toEqual(["NVIDIA", "Hello World\nNext", "Left Right\nBelow"]);
  });

  test("a font that maps its codes through a ToUnicode table is read through it, with one-byte and two-byte codes, chars and ranges", () => {
    const cmap = "/CIDInit begincmap 1 begincodespacerange <0000> <FFFF> endcodespacerange 2 beginbfchar <0001> <0048> <0002> <0069> endbfchar 1 beginbfrange <0010> <0012> <0041> endbfrange endcmap";
    const r = pdfText(pdf([{ content: "BT /F1 12 Tf <00010002> Tj [<0010> -20 <00110012>] TJ ET", cmap }]));
    expect(r.pages).toEqual(["HiABC"]);
    const narrow = "1 begincodespacerange <00> <FF> endcodespacerange 1 beginbfchar <41> <0058> endbfchar";
    expect(pdfText(pdf([{ content: "BT /F1 12 Tf (AA) Tj ET", cmap: narrow }])).pages).toEqual(["XX"]);
  });

  test("pages and fonts kept inside a compressed object stream are found too", () => {
    const r = pdfText(pdf([{ content: "BT /F1 12 Tf (Packed) Tj ET" }, { content: "BT /F1 12 Tf (Also) Tj ET" }], { objectStreams: true }));
    expect(r.pages).toEqual(["Packed", "Also"]);
  });

  test("a PDF whose pages draw no text says it is scanned; a page without text among others is an empty page", () => {
    expect(() => pdfPages(pdf([{ content: "0 0 m 100 100 l S" }]))).toThrow("no text in this PDF (scanned pages)");
    expect(pdfPages(pdf([{ content: "0 0 m 1 1 l S" }, { content: "BT (x) Tj ET" }]))).toEqual(["", "x"]);
  });
});
