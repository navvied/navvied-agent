import type { Tool } from "../types.ts";
import { changeFile } from "./edit.ts";
import { wantsManyChanges } from "./edit-text.ts";
import { place, str } from "./util.ts";

export const multiEdit: Tool = {
  name: "MultiEdit",
  readOnly: false,
  description: "Several Edits to one file, in order; if one fails none is made. edits: [{old_string, new_string, replace_all}].",
  parameters: {
    type: "object",
    properties: {
      file_path: { type: "string" },
      edits: { type: "array", items: { type: "object" } },
    },
    required: ["file_path", "edits"],
  },
  offeredWhen: wantsManyChanges,
  title: (a) => `Edit file: ${str(a.file_path)}`,
  async run(a, ctx) {
    const list = Array.isArray(a.edits) ? a.edits.filter((e): e is Record<string, unknown> => typeof e === "object" && e !== null) : [];
    if (!list.length) return 'Error: edits must be a list such as [{"old_string": "…", "new_string": "…"}].';
    return changeFile(ctx, place(ctx, a.file_path), list.map((e) => ({ from: str(e.old_string), to: str(e.new_string), all: e.replace_all === true })));
  },
};
