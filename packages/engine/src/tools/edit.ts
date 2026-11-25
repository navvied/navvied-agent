import { existsSync, readFileSync } from "node:fs";
import type { Tool, ToolContext } from "../types.ts";
import { applyChange, around, type Change } from "./edit-text.ts";
import { changedSince, check, wrote } from "./file-state.ts";
import { decode, encode, forModel, writeAtomic } from "./text-file.ts";
import { place, str } from "./util.ts";

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Changes to one existing file, all of them or none: each is made on the text the one before left. Shared by Edit and MultiEdit. */
export function changeFile(ctx: ToolContext, path: string, changes: Change[]): string {
  if (!existsSync(path)) return `Error: ${path} does not exist. To create a new file, use Write.`;
  const bytes = readFileSync(path);
  const guard = check(ctx.files, path, bytes);
  if (guard !== "ok" && guard !== "stale") return guard;
  const decoded = decode(bytes);
  if ("error" in decoded) return `Error: ${path} ${decoded.error}`;
  const { layout } = decoded;
  const model = (s: string): string => (layout.eol === "crlf" ? s.replace(/\r\n/g, "\n") : s);
  let text = forModel(decoded.text, layout);
  const done: string[] = [], notes = new Set<string>();
  let replaced = 0, first: { line: number; added: number } | undefined;
  for (const [i, c] of changes.entries()) {
    const r = applyChange(text, { ...c, from: model(c.from), to: model(c.to) }, guard === "stale");
    if ("error" in r) {
      if (guard === "stale" && /not found|matches \d+ places/.test(r.error)) return changedSince(path);
      return `Error: ${changes.length > 1 ? `change ${i + 1} of ${changes.length}: ` : ""}${r.error}${changes.length > 1 ? " Nothing was changed." : ""}`;
    }
    first ??= { line: r.line, added: model(c.to).split("\n").length - 1 };
    text = r.text;
    replaced += r.count;
    done.push(`line ${r.line}`);
    if (r.note) notes.add(r.note);
  }
  const out = encode(text, layout);
  writeAtomic(path, out);
  wrote(ctx, path, out);
  const extra = [...notes].map((n) => `\nNote: ${n}.`).join("") + (guard === "stale" ? "\nNote: the file had changed since you read it; this edit matched its current text exactly. Read it again before a change that depends on the rest of it." : "");
  if (changes.length === 1) return `Edited ${path} at line ${first!.line} (${plural(replaced, "replacement")}).${extra}\n${around(text, first!.line, first!.added)}`;
  return `Edited ${path}: ${plural(changes.length, "change")} (${done.join(", ")}), ${plural(replaced, "replacement")}.${extra}`;
}

export const edit: Tool = {
  name: "Edit",
  readOnly: false,
  description: "Replace one exact piece of text in a file; replace_all for every place it occurs.",
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
    return changeFile(ctx, place(ctx, a.file_path), [{ from: str(a.old_string), to: str(a.new_string), all: a.replace_all === true }]);
  },
};
