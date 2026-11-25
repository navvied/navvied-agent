import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { extname } from "node:path";
import { classifyFile } from "@navvied/protocol";
import type { Tool, ToolContext } from "../types.ts";
import { DOCUMENT_EXTENSIONS, pageBlock, pdfPagesAt, readDocument } from "./documents.ts";
import { hashFile, hashOf } from "./file-state.ts";
import { renderNotebook } from "./notebook.ts";
import { bomOf } from "./text-file.ts";
import { lineCount } from "./write.ts";
import { place, clip, num, str } from "./util.ts";

const MAX_FILE_BYTES = 5_000_000;
const MAX_DOCUMENT_BYTES = 40_000_000;
const MAX_IMAGE_BYTES = 12_000_000;
/** Pages of a PDF given at once: what is not asked for is not paid for. */
const MOST_PAGES = 20, FIRST_PAGES = 10;
const IMAGES = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const CHUNK = 1 << 20;

/** `3`, `2-5`, `4-` or a list of them (`1-3,7`) as page numbers, or a message for the model. */
export function pageList(spec: string, total: number): number[] | string {
  const out: number[] = [];
  for (const part of spec.split(",")) {
    const m = /^\s*(\d+)?\s*(-)?\s*(\d+)?\s*$/.exec(part);
    if (!m || (!m[1] && !m[3])) return `Error: pages "${spec}" is not like "3", "1-5" or "2,4-6".`;
    const from = Number(m[1] ?? 1), to = m[2] ? Number(m[3] ?? total) : from;
    for (let p = from; p <= Math.min(to, total); p++) if (!out.includes(p)) out.push(p);
  }
  if (!out.length) return `Error: this PDF has ${total} page${total === 1 ? "" : "s"}; "${spec}" is outside it.`;
  return out.sort((x, y) => x - y);
}

/** Lines `offset` to `offset + limit - 1` of a file too large to hold, read in pieces; `more` says whether lines follow. Nothing when the file is binary. */
function window(path: string, size: number, offset: number, limit: number): { lines: string[]; more: boolean } | undefined {
  const fd = openSync(path, "r");
  const buf = Buffer.alloc(CHUNK), decoder = new TextDecoder("utf-8");
  const lines: string[] = [];
  let carry = "", n = 0, pos = 0;
  const take = (line: string): void => { n++; if (n >= offset && lines.length < limit) lines.push(line.replace(/\r$/, "")); };
  try {
    for (;;) {
      const got = readSync(fd, buf, 0, CHUNK, null);
      if (pos === 0 && buf.subarray(0, got).includes(0)) return undefined;
      pos += got;
      const parts = (carry + decoder.decode(buf.subarray(0, got), { stream: got > 0 })).split("\n");
      carry = parts.pop()!;
      for (const [i, l] of parts.entries()) {
        take(l);
        if (lines.length >= limit) return { lines, more: i < parts.length - 1 || carry !== "" || pos < size };
      }
      if (!got) { if (carry !== "") take(carry); return { lines, more: false }; }
    }
  } finally { closeSync(fd); }
}

const gutter = (n: number, l: string): string => `${String(n).padStart(6)}\t${l.length > 2000 ? `${l.slice(0, 2000)}…` : l}`;

function numbered(content: string, offset: number, limit: number): string {
  const lines = content.split("\n");
  // A last newline ends the last line, it does not start another one.
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  if (lines.length === 1 && !lines[0]) return "The file exists but is empty.";
  if (offset > lines.length) return `The file has ${lines.length} lines; offset ${offset} is past the end.`;
  const shown = lines.slice(offset - 1, offset - 1 + limit).map((l, i) => gutter(offset + i, l)).join("\n");
  const rest = lines.length - (offset - 1 + limit);
  return clip(shown + (rest > 0 ? `\n… [${rest} more lines — raise offset to continue]` : ""));
}

function picture(path: string, bytes: Buffer, ctx: ToolContext): string | undefined {
  const kind = classifyFile(bytes);
  if (kind.kind !== "image") return undefined;
  if (bytes.length > MAX_IMAGE_BYTES) return `Error: ${path} is a picture of ${bytes.length} bytes, too large to show. Make a smaller copy (for example with a shell command) and read that.`;
  if (ctx.vision === false || !ctx.show) return `${path} is a picture (${kind.mime}, ${bytes.length} bytes). This model cannot see pictures, so it is not shown.`;
  ctx.show({ type: "image", mime: kind.mime, data: bytes.toString("base64") });
  return `${path} is a picture (${kind.mime}, ${bytes.length} bytes), shown to you in the next message.`;
}

export const read: Tool = {
  name: "Read",
  readOnly: true,
  description: "Read a file with line numbers; also pictures, notebooks, PDF.",
  parameters: {
    type: "object",
    properties: {
      file_path: { type: "string" },
      offset: { type: "number" },
      limit: { type: "number" },
      pages: { type: "string" },
    },
    required: ["file_path"],
  },
  title: (a) => `Read ${str(a.file_path)}`,
  async run(a, ctx) {
    const path = place(ctx, a.file_path);
    if (!existsSync(path)) return `Error: ${path} does not exist. Use Glob to find the right path.`;
    const st = statSync(path);
    if (st.isDirectory()) return `Error: ${path} is a directory. Use Glob to list files.`;
    if (!st.isFile()) return `Error: ${path} is not a regular file.`;
    const ext = extname(path).toLowerCase();
    const document = DOCUMENT_EXTENSIONS.has(ext);
    const offset = Math.max(1, Math.floor(num(a.offset, 1)));
    const limit = Math.min(Math.max(1, Math.floor(num(a.limit, 2000))), 5000);
    const pages = str(a.pages);
    const key = `${offset}:${limit}:${pages}`;
    const before = ctx.files?.get(path);
    if (before && before.key === key && before.mtimeMs === st.mtimeMs && before.size === st.size) return `${path} is unchanged since you read it (lines ${before.from}-${before.to}): what it showed is still above.`;
    if (document && st.size > MAX_DOCUMENT_BYTES) return `Error: ${path} is ${st.size} bytes — too large to read as a document.`;
    const seen = (bytes: Uint8Array, shown: number): void => ctx.files?.saw(path, { hash: hashOf(bytes), mtimeMs: st.mtimeMs, size: st.size, from: offset, to: offset + shown - 1, key });

    if (st.size > MAX_FILE_BYTES && !document && !IMAGES.has(ext)) {
      const w = window(path, st.size, offset, limit);
      if (!w) return `Error: ${path} looks binary.`;
      ctx.files?.saw(path, { hash: await hashFile(path), mtimeMs: st.mtimeMs, size: st.size, from: offset, to: offset + w.lines.length - 1, key });
      if (!w.lines.length) return `The file has fewer than ${offset} lines.`;
      return clip(w.lines.map((l, i) => gutter(offset + i, l)).join("\n") + (w.more ? `\n… [more lines follow — raise offset to ${offset + w.lines.length} to continue]` : ""));
    }
    const bytes = readFileSync(path);
    if (!document && ext !== ".ipynb" && (IMAGES.has(ext) || (bytes.includes(0) && !bomOf(bytes)))) { const shown = picture(path, bytes, ctx); if (shown) { seen(bytes, 0); return shown; } }
    let content: string;
    if (ext === ".pdf") {
      let all: string[];
      try { all = pdfPagesAt(bytes, path); } catch (e) { return `Error: ${path}: ${e instanceof Error ? e.message : "could not be read"}.`; }
      const wanted = pages ? pageList(pages, all.length) : Array.from({ length: Math.min(all.length, FIRST_PAGES) }, (_, i) => i + 1);
      if (typeof wanted === "string") return wanted;
      const chosen = wanted.slice(0, MOST_PAGES);
      const more = pages ? wanted.length - chosen.length : all.length - chosen.length;
      content = `PDF of ${all.length} page${all.length === 1 ? "" : "s"}${chosen.length < all.length ? `; pages ${chosen[0]}-${chosen.at(-1)} follow${more > 0 ? `, ${more} more not shown: ask for them with pages "${chosen.at(-1)! + 1}-${Math.min(all.length, chosen.at(-1)! + MOST_PAGES)}"` : ""}` : ""}\n${chosen.map((p) => pageBlock(p, all[p - 1]!.trim())).join("\n\n")}`;
    } else if (document) {
      const doc = readDocument(path, bytes);
      if (!doc.ok) return `Error: ${path}: ${doc.error}.`;
      content = doc.text;
    } else if (ext === ".ipynb") content = renderNotebook(bytes.toString("utf8"));
    else {
      if (bytes.includes(0) && !bomOf(bytes)) return `Error: ${path} looks binary.`;
      const bom = bomOf(bytes);
      content = (bom === "utf16le" ? new TextDecoder("utf-16le").decode(bytes.subarray(2)) : bom === "utf16be" ? new TextDecoder("utf-16be").decode(bytes.subarray(2)) : bytes.toString("utf8").replace(/^﻿/, "")).replace(/\r\n/g, "\n");
    }
    const out = numbered(content, offset, limit);
    seen(bytes, Math.min(limit, lineCount(content) - offset + 1));
    return out;
  },
};
