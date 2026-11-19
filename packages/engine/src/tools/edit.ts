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
    const source = readFileSync(path, "utf8");
    const from = str(a.old_string), to = str(a.new_string);
    if (!from) return "Error: old_string is empty.";
    if (from === to) return "Error: old_string and new_string are identical.";
    const count = source.split(from).length - 1;
    if (count === 0) return "Error: old_string was not found. Read the file again and copy the text exactly, including whitespace.";
    if (count > 1 && a.replace_all !== true) return `Error: old_string matches ${count} places. Add surrounding context to make it unique, or set replace_all.`;
    const line = source.slice(0, source.indexOf(from)).split("\n").length;
    writeFileSync(path, a.replace_all === true ? source.split(from).join(to) : source.replace(from, () => to));
    const n = a.replace_all === true ? count : 1;
    return `Edited ${path} at line ${line} (${n} replacement${n === 1 ? "" : "s"}).`;
  },
};
