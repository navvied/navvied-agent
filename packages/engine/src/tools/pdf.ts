import { inflateSync } from "node:zlib";

/**
 * The text of a PDF with nothing but the standard library: the page tree is followed, each page's content stream is read for the
 * strings it draws (Tj, TJ, ' and "), and the characters of a font that maps its codes through a ToUnicode table are looked up in it.
 * Scanned pages have no text to find, and a font with no table whose codes are not text comes out as nothing.
 */

interface PdfObject { dict: string; stream?: Buffer }

const MAX_STREAM = 50_000_000;

/** The first balanced `<< … >>` in `text` at or after `from`. */
function balanced(text: string, from = 0): string {
  const start = text.indexOf("<<", from);
  if (start < 0) return "";
  let depth = 0;
  for (let i = start; i < text.length - 1; i++) {
    if (text[i] === "<" && text[i + 1] === "<") { depth++; i++; }
    else if (text[i] === ">" && text[i + 1] === ">") { depth--; i++; if (depth === 0) return text.slice(start, i + 1); }
  }
  return text.slice(start);
}

function decode(dict: string, data: Buffer): Buffer | undefined {
  const filter = /\/Filter\s*(\[[^\]]*\]|\/\w+)/.exec(dict)?.[1];
  if (!filter) return data;
  if (!/^\[?\s*\/FlateDecode\s*\]?$|^\[?\s*\/Fl\s*\]?$/.test(filter.trim())) return undefined;
  try { return inflateSync(data, { maxOutputLength: MAX_STREAM }); } catch { return undefined; }
}

function objects(buf: Buffer): Map<number, PdfObject> {
  const text = buf.toString("latin1");
  const found = new Map<number, PdfObject>();
  for (const m of text.matchAll(/(\d+)\s+\d+\s+obj\b([\s\S]*?)\bendobj/g)) {
    const body = m[2]!;
    const at = body.search(/\bstream\r?\n/);
    if (at < 0) { found.set(Number(m[1]), { dict: body }); continue; }
    const dict = body.slice(0, at);
    const from = at + body.slice(at).indexOf("\n") + 1;
    const end = body.lastIndexOf("endstream");
    const whole = body.slice(from, end < from ? undefined : end);
    // The line break before `endstream` is not part of the data, unless the data itself ends with one.
    const data = decode(dict, Buffer.from(whole.replace(/\r?\n$/, ""), "latin1")) ?? (whole.endsWith("\n") ? decode(dict, Buffer.from(whole, "latin1")) : undefined);
    found.set(Number(m[1]), data ? { dict, stream: data } : { dict });
  }
  // Objects packed inside object streams (PDF 1.5): their dictionaries only.
  for (const o of [...found.values()]) {
    if (!o.stream || !/\/Type\s*\/ObjStm/.test(o.dict)) continue;
    const n = Number(/\/N\s+(\d+)/.exec(o.dict)?.[1] ?? 0), first = Number(/\/First\s+(\d+)/.exec(o.dict)?.[1] ?? 0);
    const text2 = o.stream.toString("latin1");
    const head = [...text2.slice(0, first).matchAll(/(\d+)\s+(\d+)/g)].slice(0, n);
    head.forEach((h, i) => { if (!found.has(Number(h[1]))) found.set(Number(h[1]), { dict: text2.slice(first + Number(h[2]), i + 1 < head.length ? first + Number(head[i + 1]![2]) : undefined) }); });
  }
  return found;
}

/** The value of `/Key` in a dictionary: a nested dictionary, or what an indirect reference points to. */
function entry(objs: Map<number, PdfObject>, dict: string, key: string): string {
  const m = new RegExp(`/${key}(?![A-Za-z])\\s*`).exec(dict);
  if (!m) return "";
  const rest = dict.slice(m.index + m[0].length);
  if (rest.startsWith("<<")) return balanced(rest);
  const ref = /^(\d+)\s+\d+\s+R/.exec(rest);
  if (ref) return objs.get(Number(ref[1]))?.dict ?? "";
  return rest.startsWith("[") ? rest.slice(0, rest.indexOf("]") + 1) : (/^[^\s/<>[\]]+/.exec(rest)?.[0] ?? "");
}

const refs = (s: string): number[] => [...s.matchAll(/(\d+)\s+\d+\s+R/g)].map((m) => Number(m[1]));

type CMap = Map<number, string>;

function cmapOf(stream: Buffer): { map: CMap; width: number } {
  const text = stream.toString("latin1");
  const map: CMap = new Map();
  let width = 1;
  const utf16 = (hex: string): string => { let s = ""; for (let i = 0; i + 3 < hex.length + 1; i += 4) s += String.fromCharCode(parseInt(hex.slice(i, i + 4).padEnd(4, "0"), 16)); return s; };
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const p of block[1]!.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) { width = Math.max(width, p[1]!.length / 2); map.set(parseInt(p[1]!, 16), utf16(p[2]!)); }
  }
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const p of block[1]!.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(\[[^\]]*\]|<[0-9a-fA-F]+>)/g)) {
      width = Math.max(width, p[1]!.length / 2);
      const lo = parseInt(p[1]!, 16), hi = Math.min(parseInt(p[2]!, 16), lo + 65535);
      if (p[3]!.startsWith("[")) [...p[3]!.matchAll(/<([0-9a-fA-F]+)>/g)].forEach((d, i) => { if (lo + i <= hi) map.set(lo + i, utf16(d[1]!)); });
      else { const base = utf16(p[3]!.slice(1, -1)); for (let c = lo; c <= hi; c++) map.set(c, base.slice(0, -1) + String.fromCharCode(base.charCodeAt(base.length - 1) + (c - lo))); }
    }
  }
  return { map, width };
}

type Token = { t: "str"; bytes: Buffer } | { t: "name"; v: string } | { t: "num"; v: number } | { t: "arr"; items: Token[] } | { t: "op"; v: string };

function* tokens(src: string): Generator<Token> {
  let i = 0;
  const stringAt = (): Buffer => {
    const out: number[] = [];
    let depth = 1;
    i++;
    while (i < src.length && depth > 0) {
      const c = src[i]!;
      if (c === "\\") {
        const n = src[i + 1] ?? "";
        if (/[0-7]/.test(n)) { const o = /^[0-7]{1,3}/.exec(src.slice(i + 1))![0]; out.push(parseInt(o, 8) & 255); i += 1 + o.length; continue; }
        const esc: Record<string, number> = { n: 10, r: 13, t: 9, b: 8, f: 12 };
        if (n === "\r" || n === "\n") { i += n === "\r" && src[i + 2] === "\n" ? 3 : 2; continue; }
        out.push(esc[n] ?? n.charCodeAt(0)); i += 2; continue;
      }
      if (c === "(") depth++;
      else if (c === ")") { depth--; if (depth === 0) { i++; break; } }
      out.push(c.charCodeAt(0) & 255); i++;
    }
    return Buffer.from(out);
  };
  const next = (): Token | "]" | undefined => {
    while (i < src.length && /[\s\0]/.test(src[i]!)) i++;
    if (i >= src.length) return undefined;
    const c = src[i]!;
    if (c === "%") { while (i < src.length && src[i] !== "\n" && src[i] !== "\r") i++; return next(); }
    if (c === "(") return { t: "str", bytes: stringAt() };
    if (c === "<" && src[i + 1] === "<") { i += 2; return { t: "op", v: "<<" }; }
    if (c === ">" && src[i + 1] === ">") { i += 2; return { t: "op", v: ">>" }; }
    if (c === "<") { const end = src.indexOf(">", i); const hex = src.slice(i + 1, end < 0 ? undefined : end).replace(/\s/g, ""); i = end < 0 ? src.length : end + 1; return { t: "str", bytes: Buffer.from(hex.length % 2 ? `${hex}0` : hex, "hex") }; }
    if (c === "[") {
      i++;
      const items: Token[] = [];
      for (let t = next(); t !== undefined && t !== "]"; t = next()) items.push(t);
      return { t: "arr", items };
    }
    if (c === "]") { i++; return "]"; }
    if (c === "/") { const m = /^\/[^\s/<>[\]()%]*/.exec(src.slice(i, i + 200))!; i += m[0].length; return { t: "name", v: m[0].slice(1) }; }
    const m = /^[^\s/<>[\]()%]+/.exec(src.slice(i, i + 200));
    if (!m) { i++; return next(); }
    i += m[0].length;
    return /^[+-]?(\d+\.?\d*|\.\d+)$/.test(m[0]) ? { t: "num", v: Number(m[0]) } : { t: "op", v: m[0] };
  };
  for (let t = next(); t !== undefined; t = next()) if (t !== "]") yield t;
}

interface Font { map?: CMap; width: number }

/** A move down by less than this, in the page's units, is a shift within a line (small capitals, a superscript), not a new line. */
const LINE_STEP = 3;
/** Without the widths of the glyphs, a character is taken to be this wide (in em); a gap wider than a third of an em is a space. */
const AVERAGE_EM = 0.52;
const SPACE_EM = 0.35;

function textOfContent(content: string, fonts: Map<string, Font>): string {
  let font: Font = { width: 1 };
  let size = 10;
  const lines: string[] = [];
  let line = "";
  let x = 0, y = 0, lineY = 0, lineEnd = 0, moved = false;
  const newline = (): void => { if (line.trim()) lines.push(line.trimEnd()); line = ""; };
  const show = (bytes: Buffer): void => {
    if (line && Math.abs(y - lineY) >= LINE_STEP) newline();
    const start = moved ? x : lineEnd;
    if (line && moved && start - lineEnd > SPACE_EM * size && !line.endsWith(" ")) line += " ";
    lineY = y; moved = false;
    let shown = "";
    if (!font.map) shown = bytes.toString("latin1").replace(/[^\x20-\x7e\xa0-\xff\t]/g, "");
    else for (let k = 0; k + font.width <= bytes.length; k += font.width) {
      let code = 0;
      for (let b = 0; b < font.width; b++) code = code * 256 + bytes[k + b]!;
      shown += font.map.get(code) ?? "";
    }
    line += shown;
    lineEnd = start + shown.length * AVERAGE_EM * size;
  };
  let stack: Token[] = [];
  for (const t of tokens(content)) {
    if (t.t !== "op") { stack.push(t); if (stack.length > 64) stack.shift(); continue; }
    const arg = (n: number): Token | undefined => stack[stack.length - n];
    const num = (n: number): number => { const a = arg(n); return a?.t === "num" ? a.v : 0; };
    switch (t.v) {
      case "Tf": { const n = arg(2); if (n?.t === "name") font = fonts.get(n.v) ?? { width: 1 }; size = Math.abs(num(1)) || size; break; }
      case "Tj": { const s = arg(1); if (s?.t === "str") show(s.bytes); break; }
      case "'": case "\"": { newline(); const s = arg(1); if (s?.t === "str") show(s.bytes); break; }
      case "TJ": {
        const a = arg(1);
        if (a?.t === "arr") for (const item of a.items) { if (item.t === "str") show(item.bytes); else if (item.t === "num" && item.v < -200) { line += " "; lineEnd += SPACE_EM * size; } }
        break;
      }
      case "T*": newline(); break;
      case "BT": x = 0; y = 0; moved = true; break;
      case "Td": case "TD": x += num(2); y += num(1); moved = true; break;
      case "Tm": x = num(2); y = num(1); moved = true; break;
    }
    stack = [];
  }
  newline();
  return lines.join("\n");
}

export interface PdfText { pages: string[]; }

/** The text of each page, in reading order of the page tree. A page with no text is an empty string. */
export function pdfText(buf: Buffer): PdfText {
  const objs = objects(buf);
  const root = [...objs.values()].find((o) => /\/Type\s*\/Catalog/.test(o.dict));
  const pages: { dict: string; resources: string }[] = [];
  const walk = (dict: string, resources: string, depth: number): void => {
    if (depth > 40) return;
    const own = entry(objs, dict, "Resources") || resources;
    const kids = /\/Kids\s*\[([^\]]*)\]/.exec(dict)?.[1];
    if (kids !== undefined && /\/Type\s*\/Pages/.test(dict)) { for (const k of refs(kids)) { const o = objs.get(k); if (o) walk(o.dict, own, depth + 1); } return; }
    pages.push({ dict, resources: own });
  };
  const top = root && refs(/\/Pages\s+(\d+\s+\d+\s+R)/.exec(root.dict)?.[1] ?? "")[0];
  if (top !== undefined && objs.get(top)) walk(objs.get(top)!.dict, "", 0);
  if (!pages.length) for (const [, o] of [...objs.entries()].sort((a, b) => a[0] - b[0])) if (/\/Type\s*\/Page(?![A-Za-z])/.test(o.dict)) pages.push({ dict: o.dict, resources: "" });

  const cache = new Map<number, Font>();
  const fontAt = (n: number): Font => {
    const hit = cache.get(n);
    if (hit) return hit;
    const o = objs.get(n);
    const to = o && refs(/\/ToUnicode\s+(\d+\s+\d+\s+R)/.exec(o.dict)?.[1] ?? "")[0];
    const stream = to !== undefined ? objs.get(to)?.stream : undefined;
    const cm = stream ? cmapOf(stream) : undefined;
    const font: Font = cm && cm.map.size ? { map: cm.map, width: cm.width } : { width: 1 };
    cache.set(n, font);
    return font;
  };

  if (!pages.length) {
    // No page tree (a damaged file): every stream that draws text counts as a page, with no font tables.
    const loose = [...objs.values()].filter((o) => o.stream && /\bBT\b/.test(o.stream.toString("latin1")));
    return { pages: loose.map((o) => textOfContent(o.stream!.toString("latin1"), new Map())) };
  }
  return {
    pages: pages.map((p) => {
      const fontDict = entry(objs, p.resources, "Font");
      const fonts = new Map<string, Font>();
      for (const m of fontDict.matchAll(/\/([^\s/<>[\]()]+)\s+(\d+)\s+\d+\s+R/g)) fonts.set(m[1]!, fontAt(Number(m[2])));
      const contents = entry(objs, p.dict, "Contents");
      const ids = /\/Contents\s*(\[[^\]]*\]|\d+\s+\d+\s+R)/.exec(p.dict)?.[1];
      const parts = (ids ? refs(ids) : refs(contents)).map((n) => objs.get(n)?.stream?.toString("latin1") ?? "");
      return textOfContent(parts.join("\n"), fonts);
    }),
  };
}
