import { spawnSync } from "../process-start.ts";
import { inflateRawSync } from "node:zlib";
import { pdfText } from "./pdf.ts";

/**
 * Text out of office documents and PDFs, so the agent can read a spec or a report as it reads code. Word, Excel and PowerPoint files are
 * zip files of XML, read here with nothing but the standard library. A PDF is read by `pdftotext` when this computer has it (the best
 * way), and otherwise by a plain reader that finds the text in the page streams, which is enough for most PDFs made from text.
 */
export const DOCUMENT_EXTENSIONS = new Set([".docx", ".xlsx", ".pptx", ".odt", ".ods", ".odp", ".pdf"]);

const ROWS = 500;

/** `size` is the stored (compressed) size; `usize` the size once unpacked; `unixMode` is set when the file was made on a Unix-like system. */
export interface Entry { name: string; method: number; size: number; usize: number; offset: number; flags: number; unixMode?: number }

/** The files in a zip, read from its central directory. With `strict`, a directory that is cut short or that needs zip64 is an error, not a shorter list. */
export function zipEntries(buf: Buffer, strict = false): Entry[] {
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66_000); i--) if (buf.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  if (end < 0) throw new Error("this is not a document file (no zip directory)");
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  const out: Entry[] = [];
  for (let i = 0; i < count && at + 46 <= buf.length && buf.readUInt32LE(at) === 0x02014b50; i++) {
    const nameLen = buf.readUInt16LE(at + 28), extra = buf.readUInt16LE(at + 30), comment = buf.readUInt16LE(at + 32);
    const host = buf.readUInt8(at + 5), attrs = buf.readUInt32LE(at + 38);
    out.push({ name: buf.toString("utf8", at + 46, at + 46 + nameLen), method: buf.readUInt16LE(at + 10), size: buf.readUInt32LE(at + 20), usize: buf.readUInt32LE(at + 24), offset: buf.readUInt32LE(at + 42), flags: buf.readUInt16LE(at + 8), ...(host === 3 ? { unixMode: attrs >>> 16 } : {}) });
    at += 46 + nameLen + extra + comment;
  }
  if (strict && (out.length !== count || count === 0xffff)) throw new Error("the zip directory is damaged or too large");
  return out;
}

export function zipRead(buf: Buffer, e: Entry): string {
  const nameLen = buf.readUInt16LE(e.offset + 26), extra = buf.readUInt16LE(e.offset + 28);
  const start = e.offset + 30 + nameLen + extra;
  const data = buf.subarray(start, start + e.size);
  const raw = e.method === 0 ? data : inflateRawSync(data, { maxOutputLength: 50_000_000 });
  return raw.toString("utf8");
}

const unescape = (s: string): string => s.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (_, t: string) => {
  if (t[0] === "#") { const code = t[1] === "x" || t[1] === "X" ? parseInt(t.slice(2), 16) : parseInt(t.slice(1), 10); try { return String.fromCodePoint(code); } catch { return ""; } }
  return ({ lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" } as Record<string, string>)[t.toLowerCase()] ?? "";
});
const textOf = (xml: string, tag: string): string => [...xml.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g"))].map((m) => unescape(m[1]!.replace(/<[^>]+>/g, ""))).join("");
const blocks = (xml: string, tag: string): string[] => [...xml.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g"))].map((m) => m[1]!);

function docx(buf: Buffer, entries: Entry[]): string {
  const main = entries.find((e) => e.name === "word/document.xml");
  if (!main) throw new Error("no text part in this Word file");
  const xml = zipRead(buf, main);
  const lines: string[] = [];
  const paragraph = (p: string): string => unescape(p.replace(/<w:tab\/>/g, "\t").replace(/<w:br\/>/g, "\n").replace(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g, "$1\u0001").replace(/<[^>]+>/g, "").replace(/\u0001/g, ""));
  // Tables become rows of cells joined by " | ", in the order they appear; everything else is a paragraph.
  const body = xml.replace(/<w:tbl>[\s\S]*?<\/w:tbl>/g, (t) => `\u0002${blocks(t, "w:tr").map((r) => blocks(r, "w:tc").map((c) => blocks(c, "w:p").map(paragraph).join(" ").trim()).join(" | ")).join("\n")}\u0003`);
  for (const part of body.split(/(\u0002[\s\S]*?\u0003)/)) {
    if (part.startsWith("\u0002")) lines.push(part.slice(1, -1));
    else for (const p of blocks(part, "w:p")) lines.push(paragraph(p));
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function pptx(buf: Buffer, entries: Entry[]): string {
  const slides = entries.filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.name)).sort((a, b) => Number(/\d+/.exec(a.name.slice(16))![0]) - Number(/\d+/.exec(b.name.slice(16))![0]));
  if (!slides.length) throw new Error("no slides in this PowerPoint file");
  return slides.map((s, i) => `--- Slide ${i + 1} ---\n${blocks(zipRead(buf, s), "a:p").map((p) => textOf(`<a:t>${""}</a:t>${p.replace(/<a:t(\s[^>]*)?>/g, "<a:t>")}`, "a:t")).filter(Boolean).join("\n")}`).join("\n\n");
}

function xlsx(buf: Buffer, entries: Entry[]): string {
  const get = (name: string): string | undefined => { const e = entries.find((x) => x.name === name); return e ? zipRead(buf, e) : undefined; };
  const shared = blocks(get("xl/sharedStrings.xml") ?? "", "si").map((si) => textOf(si, "t"));
  const wb = get("xl/workbook.xml") ?? "";
  const rels = get("xl/_rels/workbook.xml.rels") ?? "";
  const target = new Map([...rels.matchAll(/<Relationship\b[^>]*>/g)].map((m) => [/Id="([^"]+)"/.exec(m[0])?.[1] ?? "", /Target="([^"]+)"/.exec(m[0])?.[1] ?? ""]));
  const sheets = [...wb.matchAll(/<sheet\b[^>]*>/g)].map((m) => ({ name: unescape(/name="([^"]*)"/.exec(m[0])?.[1] ?? "Sheet"), path: target.get(/r:id="([^"]+)"/.exec(m[0])?.[1] ?? "") }));
  const out: string[] = [];
  for (const [i, sh] of sheets.entries()) {
    const path = sh.path ? `xl/${sh.path.replace(/^\/?(xl\/)?/, "")}` : `xl/worksheets/sheet${i + 1}.xml`;
    const xml = get(path);
    if (!xml) continue;
    const rows = [...xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)].slice(0, ROWS).map((r) => {
      const cells: string[] = [];
      for (const c of r[1]!.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ref = /r="([A-Z]+)\d+"/.exec(c[1]!)?.[1] ?? "";
        const col = [...ref].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
        const type = /t="([^"]+)"/.exec(c[1]!)?.[1];
        const v = /<v>([\s\S]*?)<\/v>/.exec(c[2] ?? "")?.[1] ?? "";
        const value = type === "s" ? shared[Number(v)] ?? "" : type === "inlineStr" ? textOf(c[2] ?? "", "t") : unescape(v);
        while (cells.length < col) cells.push("");
        cells[col] = value.replace(/[\t\n]/g, " ");
      }
      return cells.join("\t");
    });
    out.push(`--- Sheet: ${sh.name} ---\n${rows.join("\n")}${rows.length === ROWS ? `\n… [first ${ROWS} rows]` : ""}`);
  }
  if (!out.length) throw new Error("no sheets in this Excel file");
  return out.join("\n\n");
}

/** OpenDocument files (odt, ods, odp): one content.xml, text in text:p and text:h, tables as rows of cells. */
function odf(buf: Buffer, entries: Entry[], ext: string): string {
  const main = entries.find((e) => e.name === "content.xml");
  if (!main) throw new Error("no text part in this OpenDocument file");
  const xml = zipRead(buf, main).replace(/<office:(automatic-styles|font-face-decls)[\s\S]*?<\/office:\1>|<office:(automatic-styles|font-face-decls)\/>/g, "");
  const paragraph = (p: string): string => unescape(p.replace(/<text:tab\/>/g, "\t").replace(/<text:line-break\/>/g, "\n").replace(/<text:s(?:\s+text:c="(\d+)")?\s*\/>/g, (_, n?: string) => " ".repeat(Math.min(Number(n ?? 1), 40))).replace(/<[^>]+>/g, ""));
  const paragraphs = (x: string): string[] => [...x.matchAll(/<text:(?:p|h)(?:\s[^>]*)?>([\s\S]*?)<\/text:(?:p|h)>/g)].map((m) => paragraph(m[1]!));
  const rowsOf = (table: string): string[] => blocks(table, "table:table-row").slice(0, ROWS).map((r) => {
    const cells: string[] = [];
    for (const c of r.matchAll(/<table:(?:covered-)?table-cell\b([^>]*?)(?:\/>|>([\s\S]*?)<\/table:(?:covered-)?table-cell>)/g)) {
      const repeat = Math.min(Number(/table:number-columns-repeated="(\d+)"/.exec(c[1]!)?.[1] ?? 1), 20);
      const value = paragraphs(c[2] ?? "").join(" ").replace(/[\t\n]/g, " ");
      for (let i = 0; i < repeat; i++) cells.push(value);
    }
    while (cells.length && !cells[cells.length - 1]) cells.pop();
    return cells.join(ext === ".ods" ? "\t" : " | ");
  });
  if (ext === ".ods") {
    const out = [...xml.matchAll(/<table:table\b([^>]*)>([\s\S]*?)<\/table:table>/g)].map((t) => `--- Sheet: ${unescape(/table:name="([^"]*)"/.exec(t[1]!)?.[1] ?? "Sheet")} ---\n${rowsOf(t[2]!).join("\n")}`);
    if (!out.length) throw new Error("no sheets in this OpenDocument spreadsheet");
    return out.join("\n\n");
  }
  if (ext === ".odp") {
    const slides = [...xml.matchAll(/<draw:page\b[^>]*>([\s\S]*?)<\/draw:page>/g)];
    if (!slides.length) throw new Error("no slides in this OpenDocument presentation");
    return slides.map((s, i) => `--- Slide ${i + 1} ---\n${paragraphs(s[1]!).filter(Boolean).join("\n")}`).join("\n\n");
  }
  const body = xml.replace(/<table:table\b[^>]*>[\s\S]*?<\/table:table>/g, (t) => `<text:p>\u0002${rowsOf(t).join("\n")}\u0003</text:p>`);
  return paragraphs(body).join("\n").replace(/\u0002|\u0003/g, "").replace(/\n{3,}/g, "\n\n").trim();
}

const SCANNED = "no text in this PDF (scanned pages)";

/** The pages of a PDF as text, read with no program. */
export function pdfPages(buf: Buffer): string[] {
  const pages = pdfText(buf).pages;
  if (!pages.some((p) => p.trim())) throw new Error(SCANNED);
  return pages;
}

/** The pages of a PDF: by `pdftotext` when this computer has it (the best way), else by the plain reader. */
export function pdfPagesAt(buf: Buffer, path: string): string[] {
  const r = spawnSync("pdftotext", ["-layout", "-q", path, "-"], { encoding: "utf8", timeout: 30_000, maxBuffer: 50_000_000 });
  if (r.status === 0 && r.stdout.trim()) { const pages = r.stdout.split("\f"); if (!pages.at(-1)?.trim()) pages.pop(); return pages; }
  return pdfPages(buf);
}

export const pageBlock = (n: number, text: string): string => `--- Page ${n} ---\n${text}`;

const pdf = (buf: Buffer, path: string): string => pdfPagesAt(buf, path).map((p, i) => pageBlock(i + 1, p.trim())).join("\n\n");

/** The text of a document file, or a plain reason it cannot be read. */
export function readDocument(path: string, bytes: Buffer): { ok: true; text: string } | { ok: false; error: string } {
  try {
    const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
    if (ext === ".pdf") return { ok: true, text: pdf(bytes, path) };
    const entries = zipEntries(bytes);
    return { ok: true, text: ext === ".docx" ? docx(bytes, entries) : ext === ".pptx" ? pptx(bytes, entries) : ext === ".xlsx" ? xlsx(bytes, entries) : odf(bytes, entries, ext) };
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : "could not be read" }; }
}
