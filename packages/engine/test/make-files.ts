import { deflateRawSync, deflateSync } from "node:zlib";

function crc32(b: Buffer): number { let c, crc = 0xffffffff; for (const byte of b) { c = (crc ^ byte) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ 0xffffffff) >>> 0; }

/** A zip file made by hand, with every second entry compressed, the way real office files mix them. */
export function zip(files: Record<string, string>): Buffer {
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

const latin = (s: string) => Buffer.from(s, "latin1");
const packed = (s: string) => deflateSync(latin(s));

export interface PdfPage {
  /** The operators of the page's content stream, written as they are in a file. */
  content: string;
  /** The page uses the font `F1`, which maps its codes through this ToUnicode table. */
  cmap?: string;
}

/** A PDF made by hand: a page tree, one compressed content stream per page, and a font table for the pages that name one. */
export function pdf(pages: PdfPage[], options: { objectStreams?: boolean; encrypt?: boolean } = {}): Buffer {
  const out: Buffer[] = [latin("%PDF-1.5\n")];
  const objects: { id: number; body: Buffer }[] = [];
  let next = 3 + pages.length * 3;
  const kids: number[] = [];
  pages.forEach((p, i) => {
    const page = 3 + i * 3, stream = page + 1, font = page + 2;
    kids.push(page);
    objects.push({ id: page, body: latin(`<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${stream} 0 R >>`) });
    const data = packed(p.content);
    objects.push({ id: stream, body: Buffer.concat([latin(`<< /Length ${data.length} /Filter /FlateDecode >>\nstream\n`), data, latin("\nendstream")]) });
    if (p.cmap) {
      const map = next++, mapData = packed(p.cmap);
      objects.push({ id: font, body: latin(`<< /Type /Font /Subtype /Type0 /BaseFont /X /ToUnicode ${map} 0 R >>`) });
      objects.push({ id: map, body: Buffer.concat([latin(`<< /Length ${mapData.length} /Filter /FlateDecode >>\nstream\n`), mapData, latin("\nendstream")]) });
    } else objects.push({ id: font, body: latin("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>") });
  });
  const tree = [
    { id: 1, body: latin("<< /Type /Catalog /Pages 2 0 R >>") },
    { id: 2, body: latin(`<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${pages.length} >>`) },
  ];
  const all = options.objectStreams
    ? (() => {
        // The page tree and the pages' dictionaries go inside one compressed object stream, as a newer PDF writer does.
        const inside = [...tree, ...objects.filter((o) => !o.body.includes("stream\n") && /\/Type \/Page /.test(o.body.toString("latin1")))];
        const rest = objects.filter((o) => !inside.includes(o));
        let head = "", body = "";
        for (const o of inside) { head += `${o.id} ${body.length} `; body += `${o.body.toString("latin1")}\n`; }
        const data = packed(head + body);
        return [...rest, { id: next, body: Buffer.concat([latin(`<< /Type /ObjStm /N ${inside.length} /First ${head.length} /Length ${data.length} /Filter /FlateDecode >>\nstream\n`), data, latin("\nendstream")]) }];
      })()
    : [...tree, ...objects];
  for (const o of all.sort((a, b) => a.id - b.id)) out.push(latin(`${o.id} 0 obj\n`), o.body, latin("\nendobj\n"));
  out.push(latin(`trailer\n<< /Root 1 0 R${options.encrypt ? " /Encrypt 99 0 R" : ""} >>\n%%EOF\n`));
  return Buffer.concat(out);
}

const wordRun = (t: string) => `<w:p><w:r><w:t>${t}</w:t></w:r></w:p>`;
export const docxFile = (...paragraphs: string[]) => zip({ "[Content_Types].xml": "<Types/>", "word/document.xml": `<w:document><w:body>${paragraphs.map(wordRun).join("")}</w:body></w:document>` });
export const pptxFile = (...slides: string[]) => zip({ "ppt/presentation.xml": "<p:presentation/>", ...Object.fromEntries(slides.map((s, i) => [`ppt/slides/slide${i + 1}.xml`, `<p:sld><a:p><a:r><a:t>${s}</a:t></a:r></a:p></p:sld>`])) });
export const xlsxFile = () => zip({
  "xl/workbook.xml": `<workbook><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>`,
  "xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`,
  "xl/sharedStrings.xml": `<sst><si><t>Item</t></si><si><t>Qty</t></si></sst>`,
  "xl/worksheets/sheet1.xml": `<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>nut</t></is></c><c r="B2"><v>7</v></c></row></sheetData></worksheet>`,
});
const open = (type: string, xml: string) => zip({ mimetype: `application/vnd.oasis.opendocument.${type}`, "content.xml": `<office:document-content><office:automatic-styles><style:style/></office:automatic-styles><office:body>${xml}</office:body></office:document-content>` });
export const odtFile = () => open("text", `<office:text><text:h>Title</text:h><text:p>One<text:s text:c="2"/>two<text:tab/>three</text:p><table:table table:name="T"><table:table-row><table:table-cell><text:p>a</text:p></table:table-cell><table:table-cell><text:p>b</text:p></table:table-cell></table:table-row></table:table><text:p>Last</text:p></office:text>`);
export const odsFile = () => open("spreadsheet", `<office:spreadsheet><table:table table:name="Sheet1"><table:table-row><table:table-cell><text:p>x</text:p></table:table-cell><table:table-cell table:number-columns-repeated="2"/><table:table-cell><text:p>y</text:p></table:table-cell></table:table-row></table:table></office:spreadsheet>`);
export const odpFile = () => open("presentation", `<office:presentation><draw:page draw:name="p1"><text:p>First</text:p></draw:page><draw:page draw:name="p2"><text:p>Second</text:p></draw:page></office:presentation>`);

export const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
export const b64 = (b: Buffer | string): string => Buffer.from(b).toString("base64");
