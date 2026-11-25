import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { Tool } from "../types.ts";
import { changedSince, check, wrote } from "./file-state.ts";
import { decode, encode, writeAtomic } from "./text-file.ts";
import { place, str } from "./util.ts";

/** The lines of a text: a last newline ends the last line, it does not start another one ("a\nb\n" is two lines; an empty text has none). */
export const lineCount = (text: string): number => (text ? text.split("\n").length - (text.endsWith("\n") ? 1 : 0) : 0);

export const write: Tool = {
  name: "Write",
  readOnly: false,
  description: "Create a file, or replace it whole.",
  parameters: {
    type: "object",
    properties: { file_path: { type: "string" }, content: { type: "string" } },
    required: ["file_path", "content"],
  },
  title: (a) => `Write file: ${str(a.file_path)}`,
  async run(a, ctx) {
    const path = place(ctx, a.file_path);
    const content = str(a.content);
    const existed = existsSync(path);
    let bytes: Buffer;
    if (existed) {
      if (statSync(path).isDirectory()) return `Error: ${path} is a directory.`;
      const before = readFileSync(path);
      // An empty file holds nothing to lose.
      const guard = before.length ? check(ctx.files, path, before, `${path} exists and was not read in this conversation, and Write would replace all of it.`) : "ok";
      if (guard === "stale") return changedSince(path);
      if (guard !== "ok") return guard;
      // The replaced file's way of storing text is kept when it is plain: its mark, and its line ends when all of them are alike.
      const old = decode(before);
      bytes = encode(content, "layout" in old ? { ...old.layout, eol: old.layout.eol === "crlf" && !content.includes("\r\n") ? "crlf" : "lf" } : { bom: "", eol: "lf" });
    } else bytes = Buffer.from(content, "utf8");
    mkdirSync(dirname(path), { recursive: true });
    writeAtomic(path, bytes);
    wrote(ctx, path, bytes);
    return `${existed ? "Overwrote" : "Created"} ${path} (${lineCount(content)} line${lineCount(content) === 1 ? "" : "s"}).`;
  },
};
