/** One change to a text: the piece to replace, what goes there instead, and whether every place it occurs is meant. */
export interface Change { from: string; to: string; all: boolean }
export type Applied = { text: string; line: number; count: number; note?: string } | { error: string };

/** Typographic characters a model types plainly where a file has them (and the other way round), and what each stands for. A long dash is read as one hyphen or as two. */
const PLAIN: Record<string, string> = { "“": '"', "”": '"', "„": '"', "‘": "'", "’": "'", "‚": "'", "–": "-", "−": "-", "‑": "-", "…": "...", " ": " ", " ": " ", " ": " ", " ": " ", " ": " ", " ": " ", " ": " ", " ": " ", " ": " ", " ": " ", " ": " ", " ": " ", " ": " ", " ": " ", "　": " " };

/** A text rewritten piece by piece, with the part of the original each rewritten character came from, so a match in it can be put back on the original. */
interface Folded { s: string; from: number[]; to: number[] }

function fold(text: string, rewrite: (piece: string) => string, runs?: RegExp): Folded {
  const f: Folded = { s: "", from: [], to: [] };
  for (let i = 0; i < text.length;) {
    let piece = String.fromCodePoint(text.codePointAt(i)!);
    if (runs) { runs.lastIndex = i; const m = runs.exec(text); if (m) piece = m[0]; }
    for (const c of rewrite(piece)) { f.s += c; f.from.push(i); f.to.push(i + piece.length); }
    i += piece.length;
  }
  return f;
}

type Folder = (text: string) => Folded;
const collapsed: Folder = (text) => fold(text, (p) => (/^[ \t]+$/.test(p) ? " " : p), /[ \t]+/y);
const typed = (twoDashes: boolean): Folder => (text) => fold(text, (p) => (p === "—" ? (twoDashes ? "--" : "-") : (PLAIN[p] ?? p)));
const plain = (s: string): string => typed(false)(s).s;

/** The line numbers of a copied `cat -n` gutter ("   12\t") when every line has one. */
const GUTTER = /^ *\d+\t/;
const withoutGutter = (s: string): string => { const lines = s.split("\n"); return lines.every((l) => GUTTER.test(l)) ? lines.map((l) => l.replace(GUTTER, "")).join("\n") : s; };

const places = (text: string, piece: string): number[] => {
  const at: number[] = [];
  for (let i = text.indexOf(piece); i >= 0; i = text.indexOf(piece, i + piece.length)) at.push(i);
  return at;
};
const lineOf = (text: string, index: number): number => text.slice(0, index).split("\n").length;

interface Span { start: number; end: number; to: string }

/** Every place where `c.from` is in `text` once both are folded, cut at whole characters of the original (never inside what one character became). */
function foldedSpans(text: string, f: Folder, c: Change): Span[] {
  const hay = f(text), want = f(c.from).s;
  if (!want || (hay.s === text && want === c.from)) return [];
  const out: Span[] = [];
  for (const s of places(hay.s, want)) {
    const e = s + want.length;
    if ((s > 0 && hay.from[s - 1] === hay.from[s]) || (e < hay.s.length && hay.from[e - 1] === hay.from[e])) continue;
    out.push({ start: hay.from[s]!, end: hay.to[e - 1]!, to: c.to });
  }
  return out;
}

/** Windows of whole lines of `text` that equal the lines of `c.from` once each is rewritten by `norm`; the new text takes the file's indentation. */
function byLines(text: string, c: Change, norm: (line: string) => string): Span[] {
  const lines = text.split("\n"), want = c.from.replace(/\n$/, "").split("\n").map(norm);
  if (!want.some(Boolean)) return [];
  const offsets: number[] = [];
  let at = 0;
  for (const l of lines) { offsets.push(at); at += l.length + 1; }
  const spans: Span[] = [];
  for (let i = 0; i + want.length <= lines.length; i++) {
    if (!want.every((w, k) => norm(lines[i + k]!) === w)) continue;
    const end = offsets[i + want.length - 1]! + lines[i + want.length - 1]!.length + (c.from.endsWith("\n") ? 1 : 0);
    spans.push({ start: offsets[i]!, end, to: reindent(c, lines.slice(i, i + want.length)) });
    i += want.length - 1;
  }
  return spans;
}

const TYPOGRAPHIC = "matched with plain quotes and dashes where the file has typographic ones";

/**
 * Where `from` is in `text`. In order: exactly; without a copied gutter; the same lines whatever their indentation; with runs of spaces read as one; with plain
 * quotes, dashes and spaces for typographic ones; and both of those last two at once on whole lines. Every step only rewrites characters, none guesses at what is similar.
 */
function find(text: string, c: Change): { spans: Span[]; note?: string } {
  const exact = places(text, c.from);
  if (exact.length) return { spans: exact.map((start) => ({ start, end: start + c.from.length, to: c.to })) };
  const gutterless = withoutGutter(c.from);
  if (gutterless !== c.from) { const r = find(text, { ...c, from: gutterless, to: withoutGutter(c.to) }); if (r.spans.length) return { ...r, note: "the line numbers at the start of the lines were left out" }; }
  const trimmed = byLines(text, c, (l) => l.trim());
  if (trimmed.length) return { spans: trimmed, note: "matched the lines ignoring differences in indentation and spaces at the ends of lines" };
  const steps: [Folder, string][] = [[collapsed, "matched with runs of spaces and tabs read as one space"], [typed(false), TYPOGRAPHIC], [typed(true), TYPOGRAPHIC]];
  for (const [f, note] of steps) {
    const spans = foldedSpans(text, f, c);
    if (spans.length) return { spans, note };
  }
  const both = byLines(text, c, (l) => plain(l).replace(/[ \t]+/g, " ").trim());
  if (both.length) return { spans: both, note: "matched the lines ignoring indentation and spacing, with plain quotes and dashes where the file has typographic ones" };
  return { spans: [] };
}

/** The new text, indented like the file: each indentation the model used for a line it copied is the file's indentation for that line, and a deeper one keeps its extra. */
function reindent(c: Change, fileLines: string[]): string {
  const lead = (s: string): string => /^[ \t]*/.exec(s)![0];
  const was = new Map<string, string>();
  c.from.replace(/\n$/, "").split("\n").forEach((l, k) => { if (l.trim() && !was.has(lead(l))) was.set(lead(l), lead(fileLines[k]!)); });
  return c.to.split("\n").map((l) => {
    if (!l.trim()) return l;
    const mine = lead(l), exact = was.get(mine);
    if (exact !== undefined) return exact + l.slice(mine.length);
    const base = [...was.keys()].filter((k) => mine.startsWith(k)).sort((x, y) => y.length - x.length)[0];
    return base === undefined ? l : was.get(base)! + l.slice(base.length);
  }).join("\n");
}

/**
 * One change to a text with `\n` line ends. The piece is looked for as written first, and only when it is not there in the more
 * forgiving ways above (a note says which fired); when `exactOnly`, because the file changed since the model read it, no guess is made.
 */
export function applyChange(text: string, c: Change, exactOnly = false): Applied {
  if (!c.from) return { error: "old_string is empty." };
  if (c.from === c.to) return { error: "old_string and new_string are identical." };
  const { spans, note } = exactOnly ? { spans: places(text, c.from).map((start) => ({ start, end: start + c.from.length, to: c.to })), note: undefined } : find(text, c);
  if (!spans.length) return { error: "old_string was not found. Read the file again and copy the text exactly, including whitespace." };
  if (spans.length > 1 && !c.all) return { error: `old_string matches ${spans.length} places (lines ${spans.slice(0, 6).map((s) => lineOf(text, s.start)).join(", ")}${spans.length > 6 ? ", …" : ""}). Add surrounding context to make it unique, or set replace_all.` };
  const used = c.all ? spans : spans.slice(0, 1);
  let out = "", at = 0;
  for (const s of used) { out += text.slice(at, s.start) + s.to; at = s.end; }
  out += text.slice(at);
  return { text: out, line: lineOf(text, used[0]!.start), count: used.length, ...(note ? { note } : {}) };
}

/** A few lines around a change, numbered as Read numbers them, so the model sees the result without reading the file again. */
export function around(text: string, line: number, changed: number, most = 14): string {
  const lines = text.split("\n");
  const from = Math.max(1, line - 2), to = Math.min(lines.length, Math.min(line + changed + 1, from + most - 1));
  return lines.slice(from - 1, to).map((l, i) => `${String(from + i).padStart(6)}\t${l.length > 200 ? `${l.slice(0, 200)}…` : l}`).join("\n");
}
