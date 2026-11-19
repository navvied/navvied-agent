import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Tool } from "../types.ts";
import { place, str } from "./util.ts";

export const edit: Tool = {
  name: "Edit",
  readOnly: false,
  description: "Replace an exact piece of text in a file. old_string must match exactly once, unless replace_all is true.",
  parameters: {
    type: "object",
    properties: {
      file_path: { type: "string" },
      old_string: { type: "string" },
      new_string: { type: "string" },
      replace_all: { type: "boolean" },
    },
    required: ["file_path", "old_string", "new_string"],
  },
  title: (a) => `Edit file: ${str(a.file_path)}`,
  async run(a, ctx) {
    const path = place(ctx, a.file_path);
    if (!existsSync(path)) return `Error: ${path} does not exist. To create a new file, use Write.`;
    const original = readFileSync(path, "utf8");
    // A file of CRLF lines is shown and edited as the model writes lines (with \n): the text is matched as LF and written back as CRLF.
    const crlf = original.includes("\r\n") && !/(?<!\r)\n/.test(original);
    const lf = (text: string): string => text.replace(/\r\n/g, "\n");
    let source = original, from = str(a.old_string), to = str(a.new_string);
    if (crlf) { source = lf(original); from = lf(from); to = lf(to); }
    if (!from) return "Error: old_string is empty.";
    if (from === to) return "Error: old_string and new_string are identical.";
    const count = source.split(from).length - 1;
    if (count === 0) return "Error: old_string was not found. Read the file again and copy the text exactly, including whitespace.";
    if (count > 1 && a.replace_all !== true) return `Error: old_string matches ${count} places. Add surrounding context to make it unique, or set replace_all.`;
    const line = source.slice(0, source.indexOf(from)).split("\n").length;
    const edited = a.replace_all === true ? source.split(from).join(to) : source.replace(from, () => to);
    writeFileSync(path, crlf ? edited.replace(/\n/g, "\r\n") : edited);
    const n = a.replace_all === true ? count : 1;
    return `Edited ${path} at line ${line} (${n} replacement${n === 1 ? "" : "s"}).`;
  },
};
