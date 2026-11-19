import { paint } from "./render.ts";
import type { DiffRow } from "./steps.ts";
import { bgRgb, currentTheme, fgRgb, surfaces, type Rgb } from "./theme.ts";

const RESET = "\u001b[0m";
const plain = (s: string): number => [...s.replace(/\u001b\[[0-9;]*m/g, "")].length;

/** The lines of a change: what came out in red, what went in in green, each with its line number, tinted to the width. */
export function diffLines(rows: readonly DiffRow[], color: boolean, width: number, indent = 4): string[] {
  const t = currentTheme(), s = surfaces(t);
  const pad = " ".repeat(indent);
  return rows.map((r) => {
    if (r.kind === "more") return `${pad}${paint(color, "dim", `… ${r.text}`)}`;
    const row = `${String(r.line).padStart(4)}  ${r.kind === "add" ? "+" : "−"} ${r.text.replace(/\t/g, "    ")}`;
    if (!color) return `${pad}${row}`;
    const [bg, fg]: [Rgb, Rgb] = r.kind === "add" ? [s.addBg, s.addFg] : [s.delBg, s.delFg];
    return `${pad}${bgRgb(bg, t.truecolor)}${fgRgb(fg, t.truecolor)}${row}${" ".repeat(Math.max(0, width - indent - plain(row)))}${RESET}`;
  });
}
