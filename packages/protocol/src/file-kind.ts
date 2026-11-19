/**
 * What a file is, decided by its bytes and never by its name or the type the sender gave. Pure (no platform API, only the language and TextDecoder), so the engine
 * and a browser say the same thing about the same file, in the same sentence.
 */

export type DocumentExtension = ".docx" | ".pptx" | ".xlsx" | ".odt" | ".odp" | ".ods";

export type FileClass =
  | { kind: "image"; mime: "image/jpeg" | "image/png" | "image/gif" | "image/webp" }
  | { kind: "text" }
  | { kind: "pdf" }
  | { kind: "document"; ext: DocumentExtension }
  /** One plain sentence saying why the file is not taken. */
  | { kind: "refused"; refused: string };

export const REFUSED = {
  empty: "The file is empty.",
  old: "Old Word, PowerPoint and Excel files (doc, ppt, xls) are not supported; save it as docx, pptx or xlsx.",
  audio: "Audio files are not supported.",
  video: "Video files are not supported.",
  archive: "Archives are not supported; unpack it and attach the files you need.",
  program: "Programs are not attached.",
  picture: "This picture format is not supported; use jpg, png, webp or gif.",
  utf8: "This text is not UTF-8; save it as UTF-8 and attach it again.",
  unknown: "This kind of file cannot be read.",
  /** Not about the file: the model in use is closed to attachments. */
  noFiles: "This model does not take files here.",
} as const;

const refuse = (refused: string): FileClass => ({ kind: "refused", refused });
const starts = (b: Uint8Array, ...bytes: number[]): boolean => bytes.every((v, i) => b[i] === v);
const latin = (b: Uint8Array, at: number, length: number): string => { let s = ""; for (let i = at; i < Math.min(at + length, b.length); i++) s += String.fromCharCode(b[i]!); return s; };
const ascii = (b: Uint8Array, at: number, s: string): boolean => latin(b, at, s.length) === s;

const OFFICE: [string, DocumentExtension][] = [["word/document.xml", ".docx"], ["ppt/presentation.xml", ".pptx"], ["xl/workbook.xml", ".xlsx"]];
const OPEN_DOCUMENT: Record<string, DocumentExtension> = {
  "application/vnd.oasis.opendocument.text": ".odt", "application/vnd.oasis.opendocument.presentation": ".odp", "application/vnd.oasis.opendocument.spreadsheet": ".ods",
};

interface ZipEntry { name: string; method: number; size: number; offset: number }

/** The files of a zip, from its central directory; nothing when it is not one. */
function zipDirectory(b: Uint8Array): ZipEntry[] | undefined {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let end = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 66_000); i--) if (view.getUint32(i, true) === 0x06054b50) { end = i; break; }
  if (end < 0) return undefined;
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const out: ZipEntry[] = [];
  for (let i = 0; i < count && at + 46 <= b.length && view.getUint32(at, true) === 0x02014b50; i++) {
    const nameLength = view.getUint16(at + 28, true), extra = view.getUint16(at + 30, true), comment = view.getUint16(at + 32, true);
    out.push({ name: new TextDecoder().decode(b.subarray(at + 46, at + 46 + nameLength)), method: view.getUint16(at + 10, true), size: view.getUint32(at + 24, true), offset: view.getUint32(at + 42, true) });
    at += 46 + nameLength + extra + comment;
  }
  return out;
}

function zipKind(b: Uint8Array): FileClass {
  const entries = zipDirectory(b);
  if (!entries) return refuse(REFUSED.archive);
  for (const [name, ext] of OFFICE) if (entries.some((e) => e.name === name)) return { kind: "document", ext };
  // An OpenDocument file names its kind in its first entry, which the format requires to be stored, not compressed.
  const type = entries.find((e) => e.name === "mimetype");
  if (type && type.method === 0 && type.offset + 30 <= b.length) {
    const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const start = type.offset + 30 + view.getUint16(type.offset + 26, true) + view.getUint16(type.offset + 28, true);
    const ext = OPEN_DOCUMENT[new TextDecoder().decode(b.subarray(start, start + Math.min(type.size, 200))).trim()];
    if (ext) return { kind: "document", ext };
  }
  return refuse(entries.some((e) => /^(META-INF\/MANIFEST\.MF|AndroidManifest\.xml|classes\.dex)$/.test(e.name)) ? REFUSED.program : REFUSED.archive);
}

export function classifyFile(b: Uint8Array): FileClass {
  if (!b.length) return refuse(REFUSED.empty);
  if (starts(b, 0xff, 0xd8, 0xff)) return { kind: "image", mime: "image/jpeg" };
  if (starts(b, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return { kind: "image", mime: "image/png" };
  if (ascii(b, 0, "GIF87a") || ascii(b, 0, "GIF89a")) return { kind: "image", mime: "image/gif" };
  if (ascii(b, 0, "RIFF") && ascii(b, 8, "WEBP")) return { kind: "image", mime: "image/webp" };
  if (ascii(b, 0, "%PDF-")) return { kind: "pdf" };
  if (starts(b, 0x50, 0x4b, 0x03, 0x04)) return zipKind(b);
  if (starts(b, 0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1)) return refuse(REFUSED.old);
  if ((ascii(b, 0, "BM") && b.length > 14 && b[6] === 0) || ascii(b, 0, "II*\0") || ascii(b, 0, "MM\0*") || (ascii(b, 4, "ftyp") && /^(heic|heix|mif1|avif)/.test(latin(b, 8, 4)))) return refuse(REFUSED.picture);
  if (ascii(b, 4, "ftyp")) return refuse(/^(M4A |M4B |F4A )/.test(latin(b, 8, 4)) ? REFUSED.audio : REFUSED.video);
  if (starts(b, 0x1a, 0x45, 0xdf, 0xa3) || ascii(b, 0, "FLV\x01") || (ascii(b, 0, "RIFF") && ascii(b, 8, "AVI "))) return refuse(REFUSED.video);
  if (ascii(b, 0, "ID3") || ascii(b, 0, "OggS") || ascii(b, 0, "fLaC") || ascii(b, 0, "MThd") || ascii(b, 0, "FORM") || (ascii(b, 0, "RIFF") && ascii(b, 8, "WAVE")) || (b[0] === 0xff && [0xfb, 0xfa, 0xf3, 0xf2, 0xe3, 0xe2].includes(b[1]!))) return refuse(REFUSED.audio);
  if (starts(b, 0x1f, 0x8b) || ascii(b, 0, "Rar!") || ascii(b, 0, "BZh") || starts(b, 0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c) || starts(b, 0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00) || ascii(b, 257, "ustar") || starts(b, 0x50, 0x4b, 0x05, 0x06) || ascii(b, 0, "xar!") || starts(b, 0x28, 0xb5, 0x2f, 0xfd)) return refuse(REFUSED.archive);
  if (starts(b, 0x7f, 0x45, 0x4c, 0x46) || (ascii(b, 0, "MZ") && b.length > 64) || starts(b, 0xfe, 0xed, 0xfa, 0xce) || starts(b, 0xfe, 0xed, 0xfa, 0xcf) || starts(b, 0xce, 0xfa, 0xed, 0xfe) || starts(b, 0xcf, 0xfa, 0xed, 0xfe) || starts(b, 0xca, 0xfe, 0xba, 0xbe) || starts(b, 0x00, 0x61, 0x73, 0x6d)) return refuse(REFUSED.program);
  if (starts(b, 0xff, 0xfe) || starts(b, 0xfe, 0xff)) return refuse(REFUSED.utf8);
  const head = b.subarray(0, 8192);
  if (head.includes(0)) return refuse(REFUSED.unknown);
  try { new TextDecoder("utf-8", { fatal: true }).decode(b); } catch { return refuse(REFUSED.utf8); }
  let odd = 0;
  for (const c of head) if (c < 32 && c !== 9 && c !== 10 && c !== 13 && c !== 12 && c !== 27) odd++;
  return odd > head.length / 100 ? refuse(REFUSED.unknown) : { kind: "text" };
}
