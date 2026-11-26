import { existsSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import type { Tool } from "../types.ts";
import { changedSince, check, wrote } from "./file-state.ts";
import { decode, encode, writeAtomic } from "./text-file.ts";
import { place, str } from "./util.ts";

interface Cell { cell_type?: string; id?: string; source?: string | string[]; outputs?: Output[]; execution_count?: number | null; metadata?: object; [k: string]: unknown }
interface Output { output_type?: string; name?: string; text?: string | string[]; data?: Record<string, string | string[]>; ename?: string; evalue?: string }
interface Notebook { cells?: Cell[]; nbformat?: number; nbformat_minor?: number; [k: string]: unknown }

const joined = (v: string | string[] | undefined): string => (Array.isArray(v) ? v.join("") : v ?? "");
const OUTPUT_LIMIT = 2000;
const shorter = (s: string): string => (s.length > OUTPUT_LIMIT ? `${s.slice(0, OUTPUT_LIMIT)}… [${s.length - OUTPUT_LIMIT} more characters]` : s);

function outputText(o: Output): string {
  if (o.output_type === "stream") return joined(o.text);
  if (o.output_type === "error") return `${o.ename ?? "Error"}: ${o.evalue ?? ""}`;
  const plain = o.data?.["text/plain"];
  const picture = Object.keys(o.data ?? {}).find((k) => k.startsWith("image/"));
  return plain ? joined(plain) : picture ? `[${picture} output not shown]` : "";
}

/** A notebook as text a model can read and name cells from: each cell under a line that gives its number, type and id, then its outputs. */
export function renderNotebook(text: string): string {
  let nb: Notebook;
  try { nb = JSON.parse(text) as Notebook; } catch { return "Error: this is not a valid notebook (JSON)."; }
  const cells = nb.cells ?? [];
  if (!cells.length) return "This notebook has no cells.";
  return cells.map((c, i) => {
    const out = (c.outputs ?? []).map((o) => outputText(o)).filter(Boolean).map((t) => `[output]\n${shorter(t.replace(/\n$/, ""))}`);
    return [`# cell ${i} [${c.cell_type ?? "code"}]${c.id ? ` id=${c.id}` : ""}`, joined(c.source).replace(/\n$/, ""), ...out].join("\n");
  }).join("\n\n");
}

const lines = (s: string): string[] => s.split("\n").map((l, i, all) => (i < all.length - 1 ? `${l}\n` : l)).filter((l, i, all) => l !== "" || i < all.length - 1);

const MODES = ["replace", "insert", "delete"];

export const notebookEdit: Tool = {
  name: "NotebookEdit",
  readOnly: false,
  description: "Change one cell of a .ipynb: edit_mode replace (default), insert (after cell_id) or delete. cell_id: an id or number from Read.",
  parameters: {
    type: "object",
    properties: {
      file_path: { type: "string" },
      cell_id: { type: "string" },
      new_source: { type: "string" },
      cell_type: { type: "string" },
      edit_mode: { type: "string" },
    },
    required: ["file_path"],
  },
  offeredWhen: ({ small }) => !small,
  fixArgs: (a) => ("notebook_path" in a && !("file_path" in a) ? { ...a, file_path: a.notebook_path } : a),
  title: (a) => `Edit notebook: ${str(a.file_path)}`,
  async run(a, ctx) {
    const path = place(ctx, a.file_path);
    if (!existsSync(path)) return `Error: ${path} does not exist.`;
    const bytes = readFileSync(path);
    const guard = check(ctx.files, path, bytes);
    if (guard === "stale") return changedSince(path);
    if (guard !== "ok") return guard;
    const decoded = decode(bytes);
    if ("error" in decoded) return `Error: ${path} ${decoded.error}`;
    let nb: Notebook;
    try { nb = JSON.parse(decoded.text) as Notebook; } catch { return `Error: ${path} is not a valid notebook (JSON).`; }
    const cells = (nb.cells ??= []);
    const mode = str(a.edit_mode, "replace");
    if (!MODES.includes(mode)) return `Error: edit_mode must be one of ${MODES.join(", ")}.`;
    const wanted = a.cell_id === undefined || a.cell_id === "" ? undefined : String(a.cell_id);
    let at = wanted === undefined ? -1 : cells.findIndex((c) => c.id === wanted);
    if (wanted !== undefined && at < 0 && /^\d+$/.test(wanted)) at = Number(wanted) < cells.length ? Number(wanted) : -1;
    if (wanted !== undefined && at < 0) return `Error: no cell "${wanted}" in ${path}: it has ${cells.length} cells (numbers 0 to ${cells.length - 1}, as Read shows them).`;
    if (mode !== "insert" && at < 0) return `Error: ${mode} needs cell_id (an id or a number from Read).`;
    const type = str(a.cell_type, mode === "replace" ? cells[at]?.cell_type ?? "code" : "code");
    const source = lines(str(a.new_source));
    let what: string;
    if (mode === "delete") { cells.splice(at, 1); what = `Deleted cell ${at}`; }
    else if (mode === "replace") {
      const c = cells[at]!;
      c.cell_type = type;
      c.source = source;
      if (type === "code") { c.outputs = []; c.execution_count = null; } else { delete c.outputs; delete c.execution_count; }
      what = `Replaced cell ${at}`;
    } else {
      const c: Cell = { cell_type: type, metadata: {}, source, ...(type === "code" ? { execution_count: null, outputs: [] } : {}) };
      if ((nb.nbformat ?? 4) > 4 || (nb.nbformat_minor ?? 0) >= 5) c.id = randomBytes(4).toString("hex");
      cells.splice(at + 1, 0, c);
      what = `Inserted a ${type} cell as cell ${at + 1}`;
    }
    const indent = /^\{\n( +)"/.exec(decoded.text)?.[1]?.length ?? 1;
    const out = encode(`${JSON.stringify(nb, null, indent)}\n`, decoded.layout);
    writeAtomic(path, out);
    wrote(ctx, path, out);
    return `${what} of ${path}.`;
  },
};
