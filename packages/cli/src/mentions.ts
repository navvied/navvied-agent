import { readFileSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { classifyFile, LIMITS, type FileClass } from "@navvied/protocol";
import type { Chip } from "./tui/menu.ts";

const MAX_FILE = 20_000;
const MAX_TOTAL = 60_000;

/**
 * Expands `@path` mentions in a prompt: the text is kept, and the contents of each mentioned file inside `cwd` are appended
 * so the model has them without spending a tool call. Directories, binary files and paths outside `cwd` are left as written
 * (a binary one is picked up by `extractAttachments` instead, if that ran first).
 */
export function expandMentions(text: string, cwd: string): string {
  const root = resolve(cwd);
  const seen = new Set<string>();
  const blocks: string[] = [];
  let total = 0;
  for (const match of text.matchAll(/(?:^|\s)@([^\s@]+)/g)) {
    const rel = match[1]!.replace(/[.,;:!?)]+$/, "");
    const path = resolve(root, rel);
    if (seen.has(path) || (path !== root && !path.startsWith(root + sep))) continue;
    seen.add(path);
    try {
      if (!statSync(path).isFile()) continue;
      const bytes = readFileSync(path);
      if (bytes.includes(0)) continue;
      const body = bytes.toString("utf8").slice(0, MAX_FILE);
      if (total + body.length > MAX_TOTAL) break;
      total += body.length;
      blocks.push(`[File ${rel}]\n${body}`);
    } catch { /* not a readable file: leave the mention as text */ }
  }
  return blocks.length ? `${text}\n\n${blocks.join("\n\n")}` : text;
}

const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;

export interface Attachment { mime: string; data: string }
export interface FileAttachment extends Attachment { name: string }

export interface ExtractedAttachments {
  /** The message with every attached mention taken out: a picture or a file goes along with it, not as words. */
  text: string;
  images: Attachment[];
  files: FileAttachment[];
  /** One line per attachment: what was attached, or why it could not be (too many, too large, unreadable, refused). */
  notes: string[];
}

interface ClassifyCacheEntry { size: number; mtimeMs: number; bytes: Buffer; result: FileClass }
const classifyCache = new Map<string, ClassifyCacheEntry>();

/** What a file at `path` is, by its content, read once and kept until the file on disk changes. Nothing for a path that is not a readable file. */
function classify(path: string): { bytes: Buffer; result: FileClass } | undefined {
  let stat: { size: number; mtimeMs: number };
  try { const s = statSync(path); if (!s.isFile()) return undefined; stat = { size: s.size, mtimeMs: s.mtimeMs }; } catch { return undefined; }
  const cached = classifyCache.get(path);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached;
  let bytes: Buffer;
  try { bytes = readFileSync(path); } catch { return undefined; }
  const entry: ClassifyCacheEntry = { ...stat, bytes, result: classifyFile(bytes) };
  classifyCache.set(path, entry);
  return entry;
}

/** The `@mentions` in `text` that resolve to a file inside `cwd`, classified by content (for the chip row while composing). */
export function previewChips(text: string, cwd: string): Chip[] {
  const root = resolve(cwd);
  const chips: Chip[] = [];
  for (const match of text.matchAll(/(?:^|\s)@([^\s@]+)/g)) {
    const rel = match[1]!.replace(/[.,;:!?)]+$/, "");
    const path = resolve(root, rel);
    if (path !== root && !path.startsWith(root + sep)) continue;
    const found = classify(path);
    if (!found) continue;
    chips.push({ name: rel.replace(/^.*[\\/]/, ""), refused: found.result.kind === "refused" });
  }
  return chips;
}

/**
 * Takes the `@mentions` that name a picture or a file (anything `expandMentions` does not already inline as text) out of a message,
 * as the attachments they are. What a file is is decided by `classifyFile`, the same way the engine decides it: a kind it cannot
 * take is refused on the spot, with the sentence `classifyFile` itself gives. Up to `LIMITS.attachments` in all, each at most 15 MB;
 * past that is said in a note instead of being sent. A plain text or code file is left for `expandMentions`.
 */
export function extractAttachments(text: string, cwd: string): ExtractedAttachments {
  const root = resolve(cwd);
  interface Found { match: RegExpMatchArray; rel: string; path: string }
  const found: Found[] = [];
  for (const match of text.matchAll(/(?:^|\s)@([^\s@]+)/g)) {
    const rel = match[1]!.replace(/[.,;:!?)]+$/, "");
    const path = resolve(root, rel);
    if (path !== root && !path.startsWith(root + sep)) continue;
    found.push({ match, rel, path });
  }
  const images: Attachment[] = [];
  const files: FileAttachment[] = [];
  const notes: string[] = [];
  const cut: Found[] = [];
  for (const f of found) {
    const classified = classify(f.path);
    if (!classified) continue; // not a real, readable file: left as plain text
    const { bytes, result } = classified;
    if (result.kind === "text") continue; // expandMentions keeps inlining it, unchanged
    const name = f.rel.replace(/^.*[\\/]/, "");
    if (result.kind === "refused") { notes.push(`${name}: ${result.refused}`); cut.push(f); continue; }
    if (images.length + files.length >= LIMITS.attachments) { notes.push(`You can add up to ${LIMITS.attachments} pictures and files to one message.`); cut.push(f); continue; }
    if (bytes.byteLength > MAX_ATTACHMENT_BYTES) { notes.push(`${name} is larger than 15 MB.`); cut.push(f); continue; }
    if (result.kind === "image") images.push({ mime: result.mime, data: bytes.toString("base64") });
    else files.push({ name, mime: "application/octet-stream", data: bytes.toString("base64") });
    notes.push(`Attached ${name}.`);
    cut.push(f);
  }
  let result = text;
  for (const f of [...cut].reverse()) {
    const whole = f.match[0]!, at = f.match.index!;
    result = result.slice(0, at) + result.slice(at + whole.length);
  }
  return { text: result.replace(/ {2,}/g, " ").trim(), images, files, notes };
}
