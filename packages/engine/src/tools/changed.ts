import { patchPaths } from "./apply-patch.ts";

/** The tools that change files: the one place that knows which, and what each one's arguments say about files. */
export const FILE_WRITERS: ReadonlySet<string> = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit", "apply_patch"]);
/** The writers a rule for `Edit` also covers, as in the rest of the world's permission rules. */
export const EDIT_LIKE: ReadonlySet<string> = new Set(["MultiEdit", "NotebookEdit", "apply_patch"]);

/** The files a call of a file-changing tool would change (empty for any other tool). */
export function changedPaths(tool: string, args: Record<string, unknown>): string[] {
  if (tool === "apply_patch") return patchPaths(args.patch);
  return FILE_WRITERS.has(tool) && typeof args.file_path === "string" ? [args.file_path] : [];
}

const TEXT_KEYS = ["content", "old_string", "new_string", "new_source", "patch"];

/** The arguments with `f` applied to every text that goes into a file (also those inside the list of a MultiEdit). */
export function mapText(args: Record<string, unknown>, f: (text: string) => string): Record<string, unknown> {
  const edit = (v: unknown): unknown => (typeof v === "object" && v !== null && !Array.isArray(v) ? mapText(v as Record<string, unknown>, f) : v);
  return Object.fromEntries(Object.entries(args).map(([k, v]) => [k, TEXT_KEYS.includes(k) && typeof v === "string" ? f(v) : k === "edits" && Array.isArray(v) ? v.map(edit) : v]));
}

/** All the text a call would put into files, joined. */
export function textOf(args: Record<string, unknown>): string {
  const parts: string[] = [];
  mapText(args, (t) => { parts.push(t); return t; });
  return parts.join("\n");
}

/** The tools that only look at files, and the places a call of one looks at (a search without a place looks at the project). */
export const READERS: ReadonlySet<string> = new Set(["Read", "Glob", "Grep"]);
export function readPaths(tool: string, args: Record<string, unknown>): string[] {
  const where = tool === "Read" ? args.file_path : args.path ?? ".";
  return READERS.has(tool) && typeof where === "string" ? [where] : [];
}
