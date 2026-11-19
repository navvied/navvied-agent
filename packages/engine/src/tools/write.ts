import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Tool } from "../types.ts";
import { place, str } from "./util.ts";

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
    return `${existed ? "Overwrote" : "Created"} ${path} (${content.split("\n").length} lines).`;
  },
};
