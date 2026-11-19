import { currentTheme, bgRgb, fgRgb, surfaces } from "./theme.ts";
import { paint } from "./render.ts";

const RESET = "\u001b[0m";
const KEYWORDS = new Set(("const let var function return if else for while do switch case break continue new class extends import export from default async await try catch finally throw typeof instanceof in of " +
  "def lambda pass raise with as yield is not and or elif except None True False self fn mut pub impl struct enum trait use match go func type interface package defer select chan map range nil true false null undefined").split(" "));

const plainLength = (s: string): number => [...s.replace(/\u001b\[[0-9;]*m/g, "")].length;

/** Colours the words of one line of code: comments, strings, numbers and keywords. Good enough to read by, not a parser. */
export function highlight(line: string, color: boolean): string {
  if (!color) return line;
  const t = currentTheme();
  const accent = (s: string): string => paint(true, "cyan", s);
  const green = (s: string): string => `${fgRgb(surfaces(t).ok, t.truecolor)}${s}${RESET}`;
  const faint = (s: string): string => paint(true, "faint", s);
  const comment = /(^|\s)(\/\/|#(?!\w+\()|--)/.exec(line);
  const head = comment ? line.slice(0, comment.index + comment[1]!.length) : line;
  const tail = comment ? line.slice(comment.index + comment[1]!.length) : "";
  const body = head.replace(/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|\b(\d[\d_.]*)\b|\b([A-Za-z_][A-Za-z0-9_]*)\b/g, (m, str: string | undefined, num: string | undefined, word: string | undefined) =>
    str ? green(str) : num ? accent(num) : word && KEYWORDS.has(word) ? accent(word) : m);
  return `${body}${tail ? faint(tail) : ""}`;
}

/** Inline marks inside a line of prose: `code` and **bold**. */
function inline(text: string, color: boolean): string {
  if (!color) return text.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1");
  return text
    .replace(/`([^`]+)`/g, (_, code: string) => paint(true, "cyan", code))
    .replace(/\*\*([^*]+)\*\*/g, (_, bold: string) => paint(true, "bold", bold));
}

const splitRow = (line: string): string[] => line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
const isRule = (cells: string[]): boolean => cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c));

/**
 * Turns the answer, line by line as it arrives, into what the terminal shows: headings in bold, lists with a marker,
 * code in a tinted box with its language, and tables with aligned columns. Whole lines only: the caller shows the open line as it is.
 */
export class Markdown {
  #code: string | undefined;
  #table: string[][] = [];

  constructor(private readonly color: boolean, private readonly width: () => number) {}

  /** What to show for one finished line. Several lines can come back (a table ends), or none (a fence). */
  push(line: string): string[] {
    const out: string[] = [];
    const fence = /^\s*```\s*([\w+#.-]*)\s*$/.exec(line);
    if (this.#code !== undefined) {
      if (fence && fence[1] === "") { this.#code = undefined; return out; }
      return [this.#codeRow(line)];
    }
    const table = /^\s*\|.*\|\s*$/.test(line);
    if (table) { this.#table.push(splitRow(line)); return out; }
    out.push(...this.flush());
    if (fence) {
      this.#code = fence[1] || "text";
      return [...out, `  ${paint(this.color, "dim", this.#code)}`];
    }
    out.push(this.#prose(line));
    return out;
  }

  /** The text ended: a table still being collected is shown now. */
  flush(): string[] {
    if (!this.#table.length) return [];
    const rows = this.#table.filter((r) => !isRule(r));
    this.#table = [];
    const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => plainLength(inline(r[i] ?? "", false)))));
    return rows.flatMap((r, n) => {
      const cells = r.map((c, i) => { const shown = inline(c, this.color); return i === r.length - 1 ? shown : shown + " ".repeat(Math.max(0, widths[i]! - plainLength(shown))); });
      const line = `  ${n === 0 ? paint(this.color, "dim", cells.join("   ")) : cells.join("   ")}`;
      return n === 0 ? [line, `  ${paint(this.color, "faint", widths.map((w) => "─".repeat(w)).join("───"))}`] : [line];
    });
  }

  #codeRow(line: string): string {
    const text = ` ${highlight(line.replace(/\t/g, "    "), this.color)}`;
    if (!this.color) return `    ${text}`;
    const t = currentTheme();
    const room = Math.max(0, this.width() - 6 - plainLength(text));
    return `    ${bgRgb(surfaces(t).code, t.truecolor)}${text}${" ".repeat(room)}${RESET}`;
  }

  #prose(line: string): string {
    const heading = /^\s{0,3}#{1,6}\s+(.*)$/.exec(line);
    if (heading) return `  ${paint(this.color, "bold", inline(heading[1]!, false))}`;
    const numbered = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line);
    if (numbered) return `  ${numbered[1]}${paint(this.color, "cyan", numbered[2]!)}  ${inline(numbered[3]!, this.color)}`;
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (bullet) return `  ${bullet[1]}${paint(this.color, "cyan", "•")}  ${inline(bullet[2]!, this.color)}`;
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) return `  ${paint(this.color, "faint", "▌")} ${paint(this.color, "dim", inline(quote[1]!, this.color))}`;
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) return `  ${paint(this.color, "faint", "─".repeat(Math.min(40, Math.max(8, this.width() - 6))))}`;
    return `  ${inline(line, this.color)}`;
  }
}
