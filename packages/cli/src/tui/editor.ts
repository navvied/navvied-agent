import { visibleWidth } from "./wrap.ts";
import type { Key } from "./keys.ts";

export interface EditorEvent {
  /** A finished line: Enter was pressed. */
  submit?: string;
  /** Ctrl+C on an empty line. */
  interrupt?: boolean;
  /** Ctrl+D on an empty line. */
  eof?: boolean;
  /** The key was used by the editor. */
  handled: boolean;
}

export interface EditorLayout {
  rows: string[];
  cursor: { row: number; col: number };
}

const HISTORY = 500;
const NOT_HANDLED: EditorEvent = { handled: false };
const HANDLED: EditorEvent = { handled: true };

const isSpace = (c: string | undefined): boolean => c === " " || c === "\n";

/** The text being typed: one or more lines, a cursor, and the lines typed before. It knows nothing about the terminal. */
export class LineEditor {
  #chars: string[] = [];
  #cursor = 0;
  #history: string[] = [];
  #at = -1;
  #draft = "";

  get text(): string { return this.#chars.join(""); }
  get cursor(): number { return this.#cursor; }
  get history(): readonly string[] { return this.#history; }

  setText(text: string): void { this.#chars = [...text]; this.#cursor = this.#chars.length; this.#at = -1; }

  clear(): void { this.setText(""); }

  remember(line: string): void {
    if (!line.trim() || this.#history.at(-1) === line) return;
    this.#history.push(line);
    if (this.#history.length > HISTORY) this.#history.shift();
  }

  apply(key: Key): EditorEvent {
    switch (key.kind) {
      case "text": this.#insert(key.text); return HANDLED;
      case "paste": this.#insert(key.text.replace(/\r\n?/g, "\n").replace(/\n$/, "")); return HANDLED;
      case "alt": return this.#alt(key.text);
      case "ctrl": return this.#ctrl(key.letter);
      case "key": return this.#named(key);
      default: return NOT_HANDLED;
    }
  }

  #insert(text: string): void {
    const add = [...text];
    this.#chars.splice(this.#cursor, 0, ...add);
    this.#cursor += add.length;
    this.#at = -1;
  }

  #remove(from: number, to: number): void {
    if (to <= from) return;
    this.#chars.splice(from, to - from);
    this.#cursor = from;
    this.#at = -1;
  }

  #lineStart(from = this.#cursor): number {
    let i = from;
    while (i > 0 && this.#chars[i - 1] !== "\n") i--;
    return i;
  }

  #lineEnd(from = this.#cursor): number {
    let i = from;
    while (i < this.#chars.length && this.#chars[i] !== "\n") i++;
    return i;
  }

  #wordLeft(): number {
    let i = this.#cursor;
    while (i > 0 && isSpace(this.#chars[i - 1])) i--;
    while (i > 0 && !isSpace(this.#chars[i - 1])) i--;
    return i;
  }

  #wordRight(): number {
    let i = this.#cursor;
    while (i < this.#chars.length && isSpace(this.#chars[i])) i++;
    while (i < this.#chars.length && !isSpace(this.#chars[i])) i++;
    return i;
  }

  #recall(step: -1 | 1): EditorEvent {
    if (!this.#history.length) return HANDLED;
    if (this.#at === -1) {
      if (step === 1) return HANDLED;
      this.#draft = this.text;
      this.#at = this.#history.length - 1;
    } else {
      this.#at += step;
      if (this.#at >= this.#history.length) { const draft = this.#draft; this.setText(draft); return HANDLED; }
      if (this.#at < 0) this.#at = 0;
    }
    const at = this.#at;
    this.#chars = [...this.#history[at]!];
    this.#cursor = this.#chars.length;
    this.#at = at;
    return HANDLED;
  }

  #vertical(step: -1 | 1): EditorEvent {
    const start = this.#lineStart();
    const column = this.#cursor - start;
    if (step === -1) {
      if (start === 0) return this.#recall(-1);
      const prevStart = this.#lineStart(start - 1);
      this.#cursor = Math.min(prevStart + column, start - 1);
      return HANDLED;
    }
    const end = this.#lineEnd();
    if (end >= this.#chars.length) return this.#recall(1);
    const nextEnd = this.#lineEnd(end + 1);
    this.#cursor = Math.min(end + 1 + column, nextEnd);
    return HANDLED;
  }

  #alt(char: string): EditorEvent {
    if (char === "b") this.#cursor = this.#wordLeft();
    else if (char === "f") this.#cursor = this.#wordRight();
    else if (char === "d") this.#remove(this.#cursor, this.#wordRight());
    else return NOT_HANDLED;
    return HANDLED;
  }

  #ctrl(letter: string): EditorEvent {
    switch (letter) {
      case "a": this.#cursor = this.#lineStart(); return HANDLED;
      case "e": this.#cursor = this.#lineEnd(); return HANDLED;
      case "b": this.#cursor = Math.max(0, this.#cursor - 1); return HANDLED;
      case "f": this.#cursor = Math.min(this.#chars.length, this.#cursor + 1); return HANDLED;
      case "k": this.#remove(this.#cursor, this.#cursor === this.#lineEnd() ? Math.min(this.#cursor + 1, this.#chars.length) : this.#lineEnd()); return HANDLED;
      case "u": this.#remove(this.#lineStart(), this.#cursor); return HANDLED;
      case "w": this.#remove(this.#wordLeft(), this.#cursor); return HANDLED;
      case "p": return this.#recall(-1);
      case "n": return this.#recall(1);
      case "d":
        if (!this.#chars.length) return { handled: true, eof: true };
        this.#remove(this.#cursor, this.#cursor + 1);
        return HANDLED;
      case "c":
        if (this.#chars.length) { this.clear(); return HANDLED; }
        return { handled: true, interrupt: true };
      default: return NOT_HANDLED;
    }
  }

  #named(key: Extract<Key, { kind: "key" }>): EditorEvent {
    const jump = key.ctrl || key.alt;
    switch (key.name) {
      case "enter": {
        if (key.alt || key.shift) { this.#insert("\n"); return HANDLED; }
        const line = this.text;
        this.remember(line);
        this.clear();
        return { handled: true, submit: line };
      }
      case "backspace":
        if (key.alt) this.#remove(this.#wordLeft(), this.#cursor); else this.#remove(this.#cursor - 1, this.#cursor);
        return HANDLED;
      case "delete": this.#remove(this.#cursor, this.#cursor + 1); return HANDLED;
      case "left": this.#cursor = jump ? this.#wordLeft() : Math.max(0, this.#cursor - 1); return HANDLED;
      case "right": this.#cursor = jump ? this.#wordRight() : Math.min(this.#chars.length, this.#cursor + 1); return HANDLED;
      case "home": this.#cursor = this.#lineStart(); return HANDLED;
      case "end": this.#cursor = this.#lineEnd(); return HANDLED;
      case "up": return key.shift ? NOT_HANDLED : this.#vertical(-1);
      case "down": return key.shift ? NOT_HANDLED : this.#vertical(1);
      default: return NOT_HANDLED;
    }
  }

  /**
   * The rows to draw for a terminal `cols` wide. The prompt (already styled, `promptWidth` columns) opens the first
   * row; later rows are indented under it. An empty editor shows the placeholder instead.
   */
  layout(prompt: string, promptWidth: number, cols: number, placeholder = "", dim: (text: string) => string = (text) => text): EditorLayout {
    const room = Math.max(1, cols - promptWidth);
    const rows: string[] = [];
    const indent = " ".repeat(promptWidth);
    let row = "", used = 0;
    let cursor = { row: 0, col: promptWidth };
    const push = (): void => { rows.push(`${rows.length === 0 ? prompt : indent}${row}`); row = ""; used = 0; };

    for (let i = 0; i <= this.#chars.length; i++) {
      if (i === this.#cursor) {
        if (used >= room) push();
        cursor = { row: rows.length, col: promptWidth + used };
      }
      if (i === this.#chars.length) break;
      const ch = this.#chars[i]!;
      if (ch === "\n") { push(); continue; }
      const w = visibleWidth(ch);
      if (used + w > room) { push(); if (i === this.#cursor) cursor = { row: rows.length, col: promptWidth }; }
      row += ch;
      used += w;
    }
    if (!this.#chars.length && placeholder) {
      const text = placeholder.slice(0, Math.max(0, room));
      rows.push(`${prompt}${dim(text)}`);
      return { rows, cursor: { row: 0, col: promptWidth } };
    }
    push();
    return { rows, cursor };
  }
}
