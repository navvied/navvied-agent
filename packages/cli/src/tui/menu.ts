import { paint } from "../render.ts";
import type { Key } from "./keys.ts";
import { clip, wrap } from "./wrap.ts";

export interface Choice { label: string; hint?: string }

/** What to show around a list: a heading for the whole screen, and a notice about something that just went wrong. */
export interface Frame {
  heading?: string[];
  notice?: string[];
  /** Explanation shown under the title (steps, an address to open). */
  body?: string[];
  /** What is going on, for a screen that waits: shown with a yellow dot. */
  status?: string;
  /** Keys a waiting screen answers (a letter), shown beside Esc. */
  actions?: { key: string; label: string; run(): void }[];
}

export type MenuOutcome = { done: number } | { back: true } | { cancel: true } | undefined;

/** Key names in the accent colour with what they do beside them, separated by space instead of punctuation. */
export const keyHints = (pairs: [string, string][], color: boolean): string =>
  pairs.map(([key, does]) => `${paint(color, "cyan", paint(color, "bold", key))} ${paint(color, "dim", does)}`).join("   ");

const FILTER_FROM = 12;

/** Explanation under a title: steps or a sentence, in the quiet colour, wrapped to the width. */
function bodyRows(body: string[] | undefined, cols: number, color: boolean): string[] {
  return body?.length ? ["", ...body.flatMap((line) => wrap(line, Math.max(20, cols - 6)).map((l) => `    ${paint(color, "dim", l)}`))] : [];
}

/** A notice about something that just went wrong: a yellow dot opens it, and later lines hang under the first. */
function noticeRows(notice: string[] | undefined, cols: number, color: boolean): string[] {
  return (notice ?? []).flatMap((line, n) => wrap(line, Math.max(20, cols - 6)).map((l, i) => `  ${n === 0 && i === 0 ? paint(color, "yellow", "●") : " "} ${l}`));
}

/** A list to choose from with the arrow keys. Long lists can be narrowed by typing. */
export class Menu {
  #at: number;
  #filter = "";

  constructor(readonly title: string, readonly items: Choice[], initial = 0, readonly color = true, readonly frame: Frame = {}) {
    this.#at = Math.min(Math.max(initial, 0), Math.max(0, items.length - 1));
  }

  get filtering(): boolean { return this.items.length > FILTER_FROM; }

  get selected(): number { return this.#at; }

  #visible(): number[] {
    const needle = this.#filter.toLowerCase();
    return this.items.map((_, i) => i).filter((i) => !needle || this.items[i]!.label.toLowerCase().includes(needle));
  }

  apply(key: Key): MenuOutcome {
    const shown = this.#visible();
    const move = (step: number): void => {
      if (!shown.length) return;
      const pos = Math.max(0, shown.indexOf(this.#at));
      this.#at = shown[(pos + step + shown.length) % shown.length]!;
    };
    if (key.kind === "wheel") { move(key.direction === "up" ? -1 : 1); return undefined; }
    if (key.kind === "ctrl") {
      if (key.letter === "c" || key.letter === "d") return { cancel: true };
      if (key.letter === "p") move(-1);
      if (key.letter === "n") move(1);
      return undefined;
    }
    if (key.kind === "text") {
      if (this.filtering) { this.#filter += key.text; this.#fit(); return undefined; }
      if (/^[1-9]$/.test(key.text) && Number(key.text) <= this.items.length) { this.#at = Number(key.text) - 1; return undefined; }
      if (key.text === "k") move(-1);
      if (key.text === "j") move(1);
      return undefined;
    }
    if (key.kind !== "key") return undefined;
    switch (key.name) {
      case "up": move(-1); return undefined;
      case "down": case "tab": move(1); return undefined;
      case "pageup": move(-8); return undefined;
      case "pagedown": move(8); return undefined;
      case "home": if (shown.length) this.#at = shown[0]!; return undefined;
      case "end": if (shown.length) this.#at = shown.at(-1)!; return undefined;
      case "enter": return shown.includes(this.#at) ? { done: this.#at } : undefined;
      case "escape": return this.#filter ? (this.#filter = "", this.#fit(), undefined) : { cancel: true };
      case "left": return { back: true };
      case "backspace":
        if (this.#filter) { this.#filter = this.#filter.slice(0, -1); this.#fit(); return undefined; }
        return { back: true };
      default: return undefined;
    }
  }

  #fit(): void {
    const shown = this.#visible();
    if (shown.length && !shown.includes(this.#at)) this.#at = shown[0]!;
  }

  /** The rows to draw, at most `maxRows`, each already fitted to `cols`. */
  lines(cols: number, maxRows: number): string[] {
    const c = this.color;
    const shown = this.#visible();
    const withHints = this.items.some((it) => it.hint);
    const notice = noticeRows(this.frame.notice, cols, c);
    const header = [
      ...(this.frame.heading?.length ? [...this.frame.heading.map((l) => `  ${l}`), ""] : []),
      ...(notice.length ? [...notice, ""] : []),
      `  ${paint(c, "bold", this.title)}`,
      ...bodyRows(this.frame.body, cols, c),
      ...(this.filtering ? [`  ${paint(c, "dim", "Search")}  ${this.#filter || paint(c, "faint", "type to narrow the list")}`] : []),
      "",
    ];
    const footer = `  ${keyHints([["↑ ↓", "choose"], ["Enter", "confirm"], ["←", "back"], ["Esc", "cancel"]], c)}`;
    const room = Math.max(1, maxRows - header.length - 2);
    const per = withHints ? 2 : 1;
    const numbered = !this.filtering && this.items.length <= 9;
    const count = Math.max(1, Math.min(shown.length, Math.floor(room / per)));
    const pos = Math.max(0, shown.indexOf(this.#at));
    const top = Math.min(Math.max(0, pos - count + 1 + Math.floor(count / 2)), Math.max(0, shown.length - count));
    const body: string[] = [];
    if (!shown.length) body.push(paint(c, "dim", "  Nothing matches."));
    for (const i of shown.slice(top, top + count)) {
      const item = this.items[i]!;
      const on = i === this.#at;
      const label = numbered ? `${i + 1}  ${item.label}` : item.label;
      body.push(`    ${on ? paint(c, "cyan", "›") : " "} ${on ? paint(c, "bold", label) : label}`);
      if (withHints) body.push(`      ${numbered ? "   " : ""}${paint(c, "dim", item.hint ?? "")}`);
    }
    const more = shown.length > count ? [paint(c, "dim", `  ${top > 0 ? "↑" : " "} ${top + count < shown.length ? "↓" : " "}  ${pos + 1} of ${shown.length}`)] : [];
    return [...header, ...body, ...more, footer].map((l) => clip(l, cols));
  }
}

export type SecretOutcome = { done: string } | { back: true } | { cancel: true } | undefined;

/** A hidden field for a pasted key: it shows only how many characters arrived. */
export class Secret {
  #text: string;
  /** `reveal` shows what is typed (an address, a name); without it only the length is shown. `initial` is offered as the answer. */
  constructor(readonly title: string, readonly color = true, readonly reveal = false, initial = "", readonly frame: Frame = {}) { this.#text = initial; }

  apply(key: Key): SecretOutcome {
    if (key.kind === "text" || key.kind === "paste") { this.#text += key.text.replace(/[\r\n]/g, ""); return undefined; }
    if (key.kind === "ctrl") return key.letter === "c" || key.letter === "d" ? { cancel: true } : undefined;
    if (key.kind !== "key") return undefined;
    if (key.name === "enter") return { done: this.#text.trim() };
    if (key.name === "escape") return { cancel: true };
    if ((key.name === "left" || key.name === "backspace") && !this.#text) return { back: true };
    if (key.name === "backspace") this.#text = this.#text.slice(0, -1);
    return undefined;
  }

  lines(cols: number): string[] {
    const c = this.color;
    const shown = this.reveal
      ? `${this.#text}${paint(c, "faint", "▏")}`
      : this.#text ? paint(c, "dim", `${"•".repeat(Math.min(this.#text.length, 24))}${this.#text.length > 24 ? "…" : ""}  ${this.#text.length} characters`) : paint(c, "faint", "nothing yet");
    const notice = noticeRows(this.frame.notice, cols, c);
    const hints: [string, string][] = [["Enter", "confirm"], ["←", "back when empty"], ["Esc", "cancel"]];
    return [
      ...(this.frame.heading?.length ? [...this.frame.heading.map((l) => `  ${l}`), ""] : []),
      ...(notice.length ? [...notice, ""] : []),
      `  ${paint(c, "bold", this.title)}`, ...bodyRows(this.frame.body, cols, c), "", `    ${shown}`, "", `  ${keyHints(hints, c)}`,
    ].map((l) => clip(l, cols));
  }
}

export interface Suggestion {
  label: string;
  hint?: string;
  /** What replaces the typed word. */
  insert: string;
  /** Carry it out at once instead of leaving it for the person to finish. */
  run: boolean;
}

export interface Suggestions { from: number; items: Suggestion[] }

export type Suggest = (text: string, cursor: number) => Suggestions | undefined;

/** Rows for the list of suggestions shown above the prompt. */
export function suggestionLines(list: Suggestion[], selected: number, cols: number, maxRows: number, color: boolean): string[] {
  const room = Math.max(1, maxRows - 1);
  const count = Math.min(list.length, room);
  const top = Math.min(Math.max(0, selected - Math.floor(count / 2)), list.length - count);
  const width = Math.min(Math.max(...list.map((s) => s.label.length)) + 3, Math.floor(cols / 2));
  const rows = list.slice(top, top + count).map((s, k) => {
    const on = top + k === selected;
    const label = s.label.padEnd(width);
    return clip(`  ${on ? paint(color, "cyan", "›") : " "} ${on ? paint(color, "cyan", paint(color, "bold", label)) : label}${s.hint ? paint(color, "dim", s.hint) : ""}`, cols);
  });
  const run = list[selected]?.run ?? false;
  return [...rows, clip(keyHints([["↑ ↓", "choose"], ["Enter", run ? "run" : "complete"], ["Tab", "complete"], ["Esc", "close"]], color), cols)];
}

/** A list that changes while it is open: `next` is asked every `everyMs` and may give new choices, a new notice, or pick one for the person. */
export interface Watch {
  everyMs: number;
  next(): Promise<{ items?: Choice[]; frame?: Frame; at?: number; auto?: number } | undefined>;
}

export interface WorkContext {
  log(line: string): void;
  signal: AbortSignal;
}

/** A screen that waits for something to happen (a sign-in, an install, a key on the clipboard) while showing what is going on. */
export function workLines(title: string, frame: Frame, log: string[], cols: number, color: boolean): string[] {
  const notice = noticeRows(frame.notice, cols, color);
  const lines = [
    ...(frame.heading?.length ? [...frame.heading.map((l) => `  ${l}`), ""] : []),
    ...(notice.length ? [...notice, ""] : []),
    `  ${paint(color, "bold", title)}`,
    "",
    ...(frame.body ?? []).flatMap((l) => wrap(l, Math.max(20, cols - 6)).map((r) => `    ${paint(color, "dim", r)}`)),
    ...(frame.body?.length ? [""] : []),
    ...log.slice(-6).map((l) => `    ${paint(color, "faint", l)}`),
    ...(log.length ? [""] : []),
    ...(frame.status ? [`    ${paint(color, "yellow", "●")} ${paint(color, "dim", frame.status)}`, ""] : []),
    `  ${keyHints([...(frame.actions ?? []).map((a) => [a.key.toUpperCase(), a.label] as [string, string]), ["←", "back"], ["Esc", "cancel"]], color)}`,
  ];
  return lines.map((l) => clip(l, cols));
}
