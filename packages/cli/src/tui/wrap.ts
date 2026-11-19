const SGR = /^\u001b\[[0-9;]*m/;
const RESET = "\u001b[0m";

export const visibleWidth = (text: string): number => Bun.stringWidth(text);

interface Cell { sgr?: string; ch?: string; w: number }

function cells(text: string): Cell[] {
  const out: Cell[] = [];
  for (let i = 0; i < text.length;) {
    const m = SGR.exec(text.slice(i));
    if (m) { out.push({ sgr: m[0], w: 0 }); i += m[0].length; continue; }
    const ch = String.fromCodePoint(text.codePointAt(i)!);
    out.push({ ch, w: Bun.stringWidth(ch) });
    i += ch.length;
  }
  return out;
}

const joined = (list: Cell[]): string => list.map((c) => c.sgr ?? c.ch).join("");

/** The colour sequence in force before each cell, and after the last one. */
function colourBefore(all: Cell[]): string[] {
  const states: string[] = [];
  let state = "";
  for (const c of all) {
    states.push(state);
    if (c.sgr) state = c.sgr === "\u001b[0m" || c.sgr === "\u001b[m" ? "" : state + c.sgr;
  }
  states.push(state);
  return states;
}

/**
 * Breaks one logical line into rows of at most `cols` columns, at a space where there is one. The colour in force at a
 * break carries into the next row, and continuation rows keep the line's own indentation.
 */
export function wrap(line: string, cols: number): string[] {
  if (cols < 1 || visibleWidth(line) <= cols) return [line];
  const all = cells(line);
  const states = colourBefore(all);
  let spaces = 0;
  for (const c of all) { if (c.ch === " ") spaces++; else if (c.ch !== undefined) break; }
  const lead = Math.min(spaces, Math.floor(cols / 2));
  const rows: string[] = [];
  let start = 0;

  while (start < all.length) {
    const room = rows.length ? cols - lead : cols;
    let used = 0, end = start, soft = -1, seenText = false;
    for (; end < all.length; end++) {
      const c = all[end]!;
      if (c.ch === undefined) continue;
      if (used + c.w > room) break;
      used += c.w;
      if (c.ch === " ") { if (seenText) soft = end; } else seenText = true;
    }
    let cut = end, next = end;
    if (end < all.length && all[end]!.ch === " ") next = end + 1;
    else if (end < all.length && soft > start) { cut = soft; next = soft + 1; }
    if (next === start) { cut = start + 1; next = cut; }
    const closes = states[cut] ? RESET : "";
    rows.push(`${rows.length ? " ".repeat(lead) : ""}${states[start]}${joined(all.slice(start, cut))}${closes}`);
    start = next;
  }
  return rows;
}

/** The text cut to `cols` columns, keeping its colours and closing them. */
export function clip(text: string, cols: number): string {
  if (visibleWidth(text) <= cols) return text;
  let out = "", used = 0;
  for (const cell of cells(text)) {
    if (cell.sgr) { out += cell.sgr; continue; }
    if (used + cell.w > cols) break;
    out += cell.ch;
    used += cell.w;
  }
  return `${out}${RESET}`;
}
