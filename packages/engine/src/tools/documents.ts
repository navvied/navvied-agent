import { spawnSync } from "node:child_process";
import { inflateRawSync, inflateSync } from "node:zlib";

/**
 * Text out of office documents and PDFs, so the agent can read a spec or a report as it reads code. Word, Excel and PowerPoint files are
 * zip files of XML, read here with nothing but the standard library. A PDF is read by `pdftotext` when this computer has it (the best
 * way), and otherwise by a plain reader that finds the text in the page streams, which is enough for most PDFs made from text.
 */
export const DOCUMENT_EXTENSIONS = new Set([".docx", ".xlsx", ".pptx", ".pdf"]);

const ROWS = 500;

interface Entry { name: string; method: number; size: number; offset: number }

/** The files in a zip, read from its central directory. */
function zipEntries(buf: Buffer): Entry[] {
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66_000); i--) if (buf.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  if (end < 0) throw new Error("this is not a document file (no zip directory)");
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  const out: Entry[] = [];
  for (let i = 0; i < count && at + 46 <= buf.length && buf.readUInt32LE(at) === 0x02014b50; i++) {
    const nameLen = buf.readUInt16LE(at + 28), extra = buf.readUInt16LE(at + 30), comment = buf.readUInt16LE(at + 32);
    out.push({ name: buf.toString("utf8", at + 46, at + 46 + nameLen), method: buf.readUInt16LE(at + 10), size: buf.readUInt32LE(at + 20), offset: buf.readUInt32LE(at + 42) });
    at += 46 + nameLen + extra + comment;
  }
  return out;
}

function zipRead(buf: Buffer, e: Entry): string {
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

/** Text from a PDF with no program: the strings the page streams draw. Fonts that map characters through custom tables come out wrong or empty, and scanned pages have no text at all. */
function pdfPlain(buf: Buffer): string {
  const pages: string[] = [];
  const text = buf.toString("latin1");
  for (const m of text.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    let data: Buffer = Buffer.from(m[1]!, "latin1");
    try { data = inflateSync(data); } catch { /* not compressed, or not a page */ }
    const s = data.toString("latin1");
    if (!/\bBT\b/.test(s)) continue;
    const lines: string[] = [];
    for (const t of s.matchAll(/\[((?:[^\]\\]|\\.)*)\]\s*TJ|\(((?:[^)\\]|\\.)*)\)\s*(?:Tj|'|")/g)) {
      const parts = t[1] !== undefined ? [...t[1].matchAll(/\(((?:[^)\\]|\\.)*)\)|(-?\d+(?:\.\d+)?)/g)].map((p) => (p[1] !== undefined ? p[1] : Number(p[2]) < -200 ? " " : "")) : [t[2]!];
      lines.push(parts.join("").replace(/\\([nrtbf()\\])/g, (_, c: string) => ({ n: "\n", r: "", t: "\t", b: "", f: "", "(": "(", ")": ")", "\\": "\\" } as Record<string, string>)[c] ?? "").replace(/\\(\d{1,3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8))));
    }
    const page = lines.join("\n").trim();
    if (page) pages.push(page);
  }
  return pages.map((p, i) => `--- Page ${i + 1} ---\n${p}`).join("\n\n");
}

function pdf(buf: Buffer, path: string): string {
  const r = spawnSync("pdftotext", ["-layout", "-q", path, "-"], { encoding: "utf8", timeout: 30_000, maxBuffer: 50_000_000 });
  if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  const plain = pdfPlain(buf);
  if (!plain.trim()) throw new Error("no text found in this PDF (it may be scanned pages, which need OCR; or install pdftotext)");
  return plain;
}

/** The text of a document file, or a plain reason it cannot be read. */
export function readDocument(path: string, bytes: Buffer): { ok: true; text: string } | { ok: false; error: string } {
  try {
    const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
    if (ext === ".pdf") return { ok: true, text: pdf(bytes, path) };
    const entries = zipEntries(bytes);
    return { ok: true, text: ext === ".docx" ? docx(bytes, entries) : ext === ".pptx" ? pptx(bytes, entries) : xlsx(bytes, entries) };
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : "could not be read" }; }
}
