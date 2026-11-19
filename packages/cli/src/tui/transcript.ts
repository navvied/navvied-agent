import { wrap } from "./wrap.ts";

const MAX_LINES = 20_000;
const NON_COLOUR_ESCAPES = /\u001b\[[0-9;?]*[A-Za-ln-z@`]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[78=>]/g;
const CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001a\u001c-\u001f\u007f]/g;

/** Output meant for the conversation: only colours survive, so a stray cursor move cannot corrupt the screen. */
export function sanitize(text: string): string {
  return text.replace(NON_COLOUR_ESCAPES, "").replace(/\t/g, "    ").replace(CONTROLS, "");
}

/** Everything the program has said, as lines, wrapped to whatever width the terminal has now. */
export class Transcript {
  #lines: string[] = [""];
  /** Lines that belong under the conversation for now, such as a spinner: drawn, but never part of what was said. */
  #live: string[] = [];
  #wrapped = new Map<number, { cols: number; rows: string[] }>();

  get lineCount(): number { return this.#lines.length; }

  /** Forget everything said so far. */
  clear(): void { this.#lines = [""]; this.#live = []; this.#wrapped.clear(); }

  /** Replace the lines shown under the conversation. An empty list takes them away. */
  setLive(lines: readonly string[]): void { this.#live = lines.length ? sanitize(lines.join("\n")).split("\n") : []; }

  /** Add output. The last line stays open until a newline arrives, so streamed text keeps growing in place. */
  write(text: string): void {
    for (const part of sanitize(text).split(/(\r\n|\n|\r)/)) {
      if (part === "\n" || part === "\r\n") { this.#lines.push(""); continue; }
      if (part === "\r") { this.#drop(this.#lines.length - 1, ""); continue; }
      if (part) this.#drop(this.#lines.length - 1, this.#lines[this.#lines.length - 1]! + part);
    }
    if (this.#lines.length > MAX_LINES) {
      this.#lines.splice(0, this.#lines.length - MAX_LINES);
      this.#wrapped.clear();
    }
  }

  #drop(index: number, text: string): void {
    this.#lines[index] = text;
    this.#wrapped.delete(index);
  }

  #rows(index: number, cols: number): string[] {
    const hit = this.#wrapped.get(index);
    if (hit && hit.cols === cols) return hit.rows;
    const rows = wrap(this.#lines[index]!, cols);
    this.#wrapped.set(index, { cols, rows });
    return rows;
  }

  #liveRows(cols: number): string[] {
    const rows: string[] = [];
    for (const line of this.#live) rows.push(...wrap(line, cols));
    return rows;
  }

  /** How many screen rows the whole conversation takes at this width, with what is shown under it. */
  totalRows(cols: number): number {
    let n = 0;
    for (let i = 0; i < this.#lines.length; i++) n += this.#rows(i, cols).length;
    return n + this.#liveRows(cols).length;
  }

  #all(cols: number): string[] {
    const all: string[] = [];
    for (let i = 0; i < this.#lines.length; i++) all.push(...this.#rows(i, cols));
    return [...all, ...this.#liveRows(cols)];
  }

  /**
   * `count` rows to show, `back` rows above the newest. When everything fits it is drawn from the top and padded with
   * blanks; otherwise the newest rows sit at the bottom.
   */
  view(cols: number, count: number, back: number): string[] {
    const all = this.#all(cols);
    if (all.length <= count) return [...all, ...Array<string>(count - all.length).fill("")];
    const end = all.length - Math.min(Math.max(back, 0), all.length - count);
    return all.slice(end - count, end);
  }

  /** The most rows one can scroll back at this width with `count` rows visible. */
  maxBack(cols: number, count: number): number { return Math.max(0, this.totalRows(cols) - count); }
}
