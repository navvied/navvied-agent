import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Tool } from "../types.ts";
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
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    return `${existed ? "Overwrote" : "Created"} ${path} (${lineCount(content)} line${lineCount(content) === 1 ? "" : "s"}).`;
  },
};
