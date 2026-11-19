import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { deflateRawSync } from "node:zlib";
import { REFUSED, classifyFile } from "../src/index.ts";

const bytes = (...v: (number | string)[]): Uint8Array => Uint8Array.from(v.flatMap((x) => (typeof x === "string" ? [...x].map((c) => c.charCodeAt(0)) : [x])));

/** A zip made by hand; every second entry is compressed, the way real office files mix them. */
function zip(files: Record<string, string>): Uint8Array {
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
  return new Uint8Array(Buffer.concat([...locals, dir, end]));
}
const open = (type: string) => zip({ mimetype: `application/vnd.oasis.opendocument.${type}`, "content.xml": "<x/>" });
const why = (b: Uint8Array): string => { const c = classifyFile(b); return c.kind === "refused" ? c.refused : c.kind; };

describe("what a file is, by its content", () => {
  test("the kinds that are taken", () => {
    expect(classifyFile(bytes(0x89, "PNG", 0x0d, 0x0a, 0x1a, 0x0a))).toEqual({ kind: "image", mime: "image/png" });
    expect(classifyFile(bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0))).toEqual({ kind: "image", mime: "image/jpeg" });
    expect(classifyFile(bytes("GIF89a...."))).toEqual({ kind: "image", mime: "image/gif" });
    expect(classifyFile(bytes("RIFF", 0, 0, 0, 0, "WEBPVP8 "))).toEqual({ kind: "image", mime: "image/webp" });
    expect(classifyFile(bytes("%PDF-1.7\n"))).toEqual({ kind: "pdf" });
    expect(classifyFile(zip({ "[Content_Types].xml": "<x/>", "word/document.xml": "<x/>" }))).toEqual({ kind: "document", ext: ".docx" });
    expect(classifyFile(zip({ "ppt/presentation.xml": "<x/>" }))).toEqual({ kind: "document", ext: ".pptx" });
    expect(classifyFile(zip({ "xl/workbook.xml": "<x/>" }))).toEqual({ kind: "document", ext: ".xlsx" });
    expect(classifyFile(open("text"))).toEqual({ kind: "document", ext: ".odt" });
    expect(classifyFile(open("spreadsheet"))).toEqual({ kind: "document", ext: ".ods" });
    expect(classifyFile(open("presentation"))).toEqual({ kind: "document", ext: ".odp" });
    expect(classifyFile(new TextEncoder().encode("fn main() { println!(\"héllo\"); }\n"))).toEqual({ kind: "text" });
    expect(classifyFile(new TextEncoder().encode("﻿a,b\n1,2\n"))).toEqual({ kind: "text" });
  });

  test("the kinds that are refused, each with its own sentence", () => {
    expect(why(new Uint8Array())).toBe(REFUSED.empty);
    expect(why(bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0))).toMatch(/Old Word, PowerPoint and Excel files/);
    expect(why(bytes("ID3", 3, 0, 0, 0, 0, 0, 0))).toBe(REFUSED.audio);
    expect(why(bytes(0, 0, 0, 0x18, "ftypM4A ", 0, 0, 0, 0))).toBe(REFUSED.audio);
    expect(why(bytes(0, 0, 0, 0x18, "ftypisom", 0, 0, 0, 0))).toBe(REFUSED.video);
    expect(why(bytes(0x1a, 0x45, 0xdf, 0xa3, 0, 0))).toBe(REFUSED.video);
    expect(why(bytes(0x1f, 0x8b, 8, 0, 0, 0))).toBe(REFUSED.archive);
    expect(why(zip({ "notes.txt": "hello" }))).toBe(REFUSED.archive);
    expect(why(zip({ "META-INF/MANIFEST.MF": "x", "a.class": "y" }))).toBe(REFUSED.program);
    expect(why(bytes(0x7f, "ELF", 2, 1, 1, 0))).toBe(REFUSED.program);
    expect(why(Uint8Array.from([0x4d, 0x5a, ...new Array(100).fill(0)]))).toBe(REFUSED.program);
    expect(why(Uint8Array.from([0x42, 0x4d, ...new Array(20).fill(0)]))).toBe(REFUSED.picture);
    expect(why(bytes(0xff, 0xfe, 0x61, 0))).toBe(REFUSED.utf8);
    expect(why(bytes(0x61, 0xff, 0xfe, 0x62))).toBe(REFUSED.utf8);
    expect(why(bytes(1, 2, 0, 3))).toBe(REFUSED.unknown);
  });

  test("a damaged zip, or an OpenDocument file whose type is compressed, is an archive and never throws", () => {
    expect(why(bytes("PK", 3, 4, 1, 2, 3))).toBe(REFUSED.archive);
    expect(why(zip({ "x.txt": "a", mimetype: "application/vnd.oasis.opendocument.text" }))).toBe(REFUSED.archive);
  });

  test("it works on a view into a larger buffer, as a browser or a socket hands one over", () => {
    const inner = open("text");
    const outer = new Uint8Array(inner.length + 20);
    outer.set(inner, 10);
    expect(classifyFile(outer.subarray(10, 10 + inner.length))).toEqual({ kind: "document", ext: ".odt" });
  });

  test("it uses nothing but the language, so a browser can run it", () => {
    const source = readFileSync(new URL("../src/file-kind.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/\bimport\b|\bBuffer\b|\bBun\b|\bprocess\b|node:/);
  });
});
