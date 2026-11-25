import { chmodSync, existsSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** How a file's text is stored: the byte-order mark it starts with (which also says its encoding) and its line ends. */
export interface Layout { bom: "" | "utf8" | "utf16le" | "utf16be"; eol: "lf" | "crlf" | "mixed" }

const BOMS = { utf8: [0xef, 0xbb, 0xbf], utf16le: [0xff, 0xfe], utf16be: [0xfe, 0xff] } as const;

export function bomOf(b: Uint8Array): Layout["bom"] {
  for (const [name, mark] of Object.entries(BOMS)) if (mark.every((x, i) => b[i] === x)) return name as Layout["bom"];
  return "";
}

/** The text of a file and how it was stored, or why it cannot be edited: a file that is not valid text would be damaged by writing it back. */
export function decode(bytes: Uint8Array): { text: string; layout: Layout } | { error: string } {
  const bom = bomOf(bytes);
  const skip = bom === "utf8" ? 3 : bom ? 2 : 0;
  let text: string;
  try { text = new TextDecoder(bom === "utf16le" ? "utf-16le" : bom === "utf16be" ? "utf-16be" : "utf-8", { fatal: true }).decode(bytes.subarray(skip)); }
  catch { return { error: "is not valid UTF-8 text (a legacy encoding or a binary file), so it cannot be edited here without damaging it. Change it with a shell command that keeps its encoding, or ask the person." }; }
  const crlf = (text.match(/\r\n/g) ?? []).length, lf = (text.match(/\n/g) ?? []).length - crlf;
  return { text, layout: { bom, eol: crlf && !lf ? "crlf" : crlf ? "mixed" : "lf" } };
}

/** The text in the form the model works with: a file of CRLF lines is written, matched and shown with plain `\n`. */
export const forModel = (text: string, l: Layout): string => (l.eol === "crlf" ? text.replace(/\r\n/g, "\n") : text);

export function encode(text: string, l: Layout): Buffer {
  const body = l.eol === "crlf" ? text.replace(/\r?\n/g, "\r\n") : text;
  if (l.bom === "utf8") return Buffer.concat([Buffer.from(BOMS.utf8), Buffer.from(body, "utf8")]);
  if (l.bom === "utf16le") return Buffer.concat([Buffer.from(BOMS.utf16le), Buffer.from(body, "utf16le")]);
  if (l.bom === "utf16be") return Buffer.concat([Buffer.from(BOMS.utf16be), Buffer.from(body, "utf16le").swap16()]);
  return Buffer.from(body, "utf8");
}

let counter = 0;

/** The file is replaced whole or not at all: written beside it and renamed over it, with the rights of the file it replaces. A link is followed, not replaced. */
export function writeAtomic(path: string, data: Uint8Array): void {
  const target = existsSync(path) ? realpathSync(path) : path;
  const temp = join(dirname(target), `.${basename(target)}.${process.pid}.${++counter}.tmp`);
  try {
    writeFileSync(temp, data);
    if (existsSync(target)) chmodSync(temp, statSync(target).mode & 0o7777);
    renameSync(temp, target);
  } catch (e) { rmSync(temp, { force: true }); throw e; }
}
