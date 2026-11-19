import { existsSync, readFileSync, statSync } from "node:fs";
import type { Tool } from "../types.ts";
import { extname } from "node:path";
import { DOCUMENT_EXTENSIONS, readDocument } from "./documents.ts";
import { place, clip, num, str } from "./util.ts";

const MAX_FILE_BYTES = 5_000_000;
const MAX_DOCUMENT_BYTES = 40_000_000;

export const read: Tool = {
  name: "Read",
  readOnly: true,
  description: "Read a file, with line numbers (Word, Excel, PowerPoint and PDF files too). Give offset and limit for a part.",
  parameters: {
    type: "object",
    properties: {
      file_path: { type: "string" },
      offset: { type: "number" },
      limit: { type: "number" },
    },
    required: ["file_path"],
  },
  title: (a) => `Read ${str(a.file_path)}`,
  async run(a, ctx) {
    const path = place(ctx, a.file_path);
    if (!existsSync(path)) return `Error: ${path} does not exist. Use Glob to find the right path.`;
    const st = statSync(path);
    if (st.isDirectory()) return `Error: ${path} is a directory. Use Glob to list files.`;
    const document = DOCUMENT_EXTENSIONS.has(extname(path).toLowerCase());
    if (document && st.size > MAX_DOCUMENT_BYTES) return `Error: ${path} is ${st.size} bytes — too large to read as a document.`;
    if (!document && st.size > MAX_FILE_BYTES) return `Error: ${path} is ${st.size} bytes — too large to read whole. Use Grep, or Read with offset and limit on a smaller file.`;
    const bytes = readFileSync(path);
    let content: string;
    if (document) {
      const doc = readDocument(path, bytes);
      if (!doc.ok) return `Error: ${path}: ${doc.error}.`;
      content = doc.text;
    } else {
      if (bytes.includes(0)) return `Error: ${path} looks binary.`;
      content = bytes.toString("utf8");
    }
    const lines = content.split("\n");
    const offset = Math.max(1, Math.floor(num(a.offset, 1)));
    const limit = Math.min(Math.max(1, Math.floor(num(a.limit, 2000))), 5000);
    const shown = lines.slice(offset - 1, offset - 1 + limit)
      .map((l, i) => `${String(offset + i).padStart(6)}\t${l.length > 2000 ? `${l.slice(0, 2000)}…` : l}`)
      .join("\n");
    const rest = lines.length - (offset - 1 + limit);
    return clip(shown + (rest > 0 ? `\n… [${rest} more lines — raise offset to continue]` : ""));
  },
};
