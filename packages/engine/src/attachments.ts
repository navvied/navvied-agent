import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { classifyFile, type FileClass, type FileInput, type FileKind, type FileNote } from "@navvied/protocol";
import { pdfPages, readDocument } from "./tools/documents.ts";
import type { Part } from "./types.ts";

/**
 * Files the person attaches to a prompt. What a file is, is decided by its bytes: the name and the type the sender gave only label it.
 * Every accepted file is saved in the session's attachment folder (never in the project) and the model is told where, with the text
 * that could be read from it, so a long file is read further with the ordinary Read tool.
 */

/** A name that is safe as a file name here: no folders, no odd characters, and the extension its content has. */
export function safeName(name: string, ext?: string): string {
  let base = basename(name.replace(/\\/g, "/")).replace(/[^\p{L}\p{N}._ ()+-]/gu, "_").replace(/^[.\s]+/, "").trim().slice(0, 100) || "file";
  if (ext && extname(base).toLowerCase() !== ext) base = `${extname(base) && /^\.[a-z0-9]{1,5}$/i.test(extname(base)) ? base.slice(0, -extname(base).length) : base}${ext}`;
  return base;
}

function uniquePath(dir: string, name: string): string {
  const ext = extname(name), stem = name.slice(0, name.length - ext.length);
  for (let n = 1; ; n++) { const p = join(dir, n === 1 ? name : `${stem} (${n})${ext}`); if (!existsSync(p)) return p; }
}

export interface ReceiveOptions {
  /** The session's attachment folder; made when the first file is saved. */
  dir: string;
  /** Whether the model can see pictures (absent: not known, so the picture is sent). */
  vision?: boolean;
  /** Characters of extracted text all the files together may put in the conversation. */
  budget: number;
  /** The model's service reads a PDF itself: the original goes along with its text. */
  readsPdf: boolean;
}

export interface Received {
  notes: FileNote[];
  /** What the model is told, one block per file. */
  text: string;
  /** The pictures and PDFs sent as they are. */
  parts: Part[];
  /** Some picture was left out because the model cannot see pictures. */
  blind: boolean;
}

const NATIVE_PDF_PAGES = 100;
const MIN_SHARE = 1500;

interface Read { text: string; pages?: number; note?: string }

function extract(bytes: Buffer, s: Extract<FileClass, { kind: "text" | "pdf" | "document" }>): Read | { error: string } {
  if (s.kind === "text") return { text: bytes.toString("utf8").replace(/^﻿/, "") };
  if (s.kind === "pdf") {
    if (/\/Encrypt\b/.test(bytes.toString("latin1", Math.max(0, bytes.length - 4096)))) return { error: "This PDF is protected with a password." };
    let pages: string[];
    try { pages = pdfPages(bytes); } catch (e) { return e instanceof Error && /scanned/.test(e.message) ? { text: "", pages: pageCount(bytes), note: e.message } : { error: `This PDF could not be read: ${e instanceof Error ? e.message : "damaged file"}.` }; }
    return { text: pages.map((p, i) => `--- Page ${i + 1} ---\n${p}`).join("\n\n"), pages: pages.length };
  }
  const doc = readDocument(`file${s.ext}`, bytes);
  if (!doc.ok) return { error: `This file could not be read: ${doc.error}.` };
  const slides = s.ext === ".pptx" || s.ext === ".odp" ? doc.text.match(/^--- Slide \d+ ---$/gm)?.length : undefined;
  return { text: doc.text, ...(slides ? { pages: slides } : {}) };
}

function pageCount(b: Buffer): number {
  const text = b.toString("latin1");
  const leaves = text.match(/\/Type\s*\/Page(?![A-Za-z])/g)?.length ?? 0;
  return leaves || Math.max(0, ...[...text.matchAll(/\/Type\s*\/Pages[^>]*\/Count\s+(\d+)|\/Count\s+(\d+)[^>]*\/Type\s*\/Pages/g)].map((m) => Number(m[1] ?? m[2])));
}

const describe = (kind: FileKind, pages?: number): string => (kind === "image" ? "image" : pages ? `${pages} ${pages === 1 ? "page" : "pages"}` : kind === "pdf" ? "PDF" : kind === "text" ? "text" : "document");

export function receive(files: readonly FileInput[], o: ReceiveOptions): Received {
  const out: Received = { notes: [], text: "", parts: [], blind: false };
  const blocks: string[] = [];
  const decoded = files.map((f) => ({ f, bytes: Buffer.from(f.data, "base64") }));
  const sniffed = decoded.map((d) => classifyFile(d.bytes));
  const readers = sniffed.filter((s) => s.kind === "text" || s.kind === "pdf" || s.kind === "document").length;
  const share = Math.max(MIN_SHARE, Math.floor(o.budget / Math.max(1, readers)));

  for (const [i, { f, bytes }] of decoded.entries()) {
    const s = sniffed[i]!;
    const refused = (note: string): void => { out.notes.push({ name: f.name, kind: "refused", note }); blocks.push(`not attached: ${f.name}. ${note}`); };
    if (s.kind === "refused") { refused(s.refused); continue; }
    const content = s.kind === "image" ? undefined : extract(bytes, s);
    if (content && "error" in content) { refused(content.error); continue; }
    const ext = s.kind === "pdf" ? ".pdf" : s.kind === "document" ? s.ext : s.kind === "image" ? ({ "image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif", "image/webp": ".webp" })[s.mime] : undefined;
    const path = uniquePath(o.dir, safeName(f.name, ext));
    try { mkdirSync(o.dir, { recursive: true, mode: 0o700 }); writeFileSync(path, bytes, { mode: 0o600 }); }
    catch { refused("The file could not be saved on this computer."); continue; }

    if (s.kind === "image") {
      if (o.vision === false) { out.blind = true; out.notes.push({ name: f.name, kind: "image", note: "this model cannot see pictures" }); blocks.push(`attached: ${f.name} (image) saved at ${path}. It is not shown to you: this model cannot see pictures.`); continue; }
      out.notes.push({ name: f.name, kind: "image" });
      blocks.push(`attached: ${f.name} (image) saved at ${path}`);
      out.parts.push({ type: "image", mime: s.mime, data: f.data });
      continue;
    }
    const c = content as Read;
    const kind: FileKind = s.kind;
    out.notes.push({ name: f.name, kind, ...(c.pages ? { pages: c.pages } : {}), ...(c.note ? { note: c.note } : {}) });
    let body = c.text;
    if (body.length > share) {
      const cut = body.lastIndexOf("\n", share);
      body = `${body.slice(0, cut > share / 2 ? cut : share)}\n… [${body.length - Math.min(body.length, cut > share / 2 ? cut : share)} more characters not shown: read the rest with Read on the path above, using offset and limit]`;
    }
    const native = s.kind === "pdf" && o.readsPdf && (c.pages ?? 0) <= NATIVE_PDF_PAGES;
    if (native) out.parts.push({ type: "file", name: basename(path), mime: "application/pdf", data: f.data });
    blocks.push(`attached: ${f.name} (${describe(kind, c.pages)}) saved at ${path}${c.note ? `. ${c.note}` : ""}${body ? `\n${body}` : ""}`);
  }
  out.text = blocks.join("\n\n");
  return out;
}
