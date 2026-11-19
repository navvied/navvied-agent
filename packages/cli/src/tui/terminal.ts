import { paint } from "../render.ts";
import { LineEditor } from "./editor.ts";
import { composeFrame, viewportRows } from "./frame.ts";
import { KeyParser, type Key } from "./keys.ts";
import { Menu, Secret, chipLines, keyHints, suggestionLines, workLines, type Chip, type Choice, type Frame, type Suggest, type Suggestion, type Watch, type WorkContext } from "./menu.ts";
import { Transcript } from "./transcript.ts";
import { visibleWidth, wrap } from "./wrap.ts";

export interface TuiOptions {
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
  color: boolean;
  /** Mouse reporting lets the wheel scroll the conversation; selecting text then needs a modifier key. */
  mouse: boolean;
}

export type IdleKey = "shift-tab" | "escape" | "ctrl-o";

type Modal =
  | { kind: "menu"; menu: Menu; done: (value: number | "back" | undefined) => void; timer?: ReturnType<typeof setInterval> }
  | { kind: "secret"; secret: Secret; done: (value: string | "back" | undefined) => void }
  | { kind: "view"; title: string; source: () => string[]; at: number | "end"; done: () => void; timer?: ReturnType<typeof setInterval> }
  | { kind: "work"; title: string; frame: Frame; log: string[]; stop: (outcome: "back" | undefined) => void };

const ENTER = "\u001b[?1049h\u001b[2J\u001b[?2004h";
const LEAVE = "\u001b[?2004l\u001b[?25h\u001b[?1049l";
const MOUSE_ON = "\u001b[?1000h\u001b[?1006h";
const MOUSE_OFF = "\u001b[?1006l\u001b[?1000l";
const WHEEL_ROWS = 3;

/** The top rule while scrolled back: it says how to return and fills the rest of the row. */
function scrolledRule(cols: number, color: boolean): string {
  const lead = `${paint(color, "faint", "── ")}${keyHints([["PageDown", "newer output"], ["Esc", "back to the latest"]], color)} `;
  return `${lead}${paint(color, "faint", "─".repeat(Math.max(0, cols - visibleWidth(lead))))}`;
}
const PALETTE_ROWS = 10;

/**
 * The whole-screen interface: the conversation fills the window and scrolls inside it, the prompt sits between two
 * rules at the bottom with a status line under it, and menus open over the conversation. It uses the terminal's
 * alternate screen, so the shell's history never shows and is back untouched when the program ends.
 */
export class Tui {
  readonly transcript = new Transcript();
  readonly #o: TuiOptions;
  readonly #editor = new LineEditor();
  readonly #parser = new KeyParser();
  readonly #queue: string[] = [];
  readonly #idleKeys = new Set<(key: IdleKey) => void>();
  readonly #interrupts = new Set<() => void>();
  #waiting: (() => void) | undefined;
  #ended = false;
  #active = false;
  #prompt = "❯ ";
  #placeholder = "";
  #status: () => string = () => "";
  #suggest: Suggest | undefined;
  #echo: ((line: string) => string | undefined) | undefined;
  #chips: ((text: string) => Chip[]) | undefined;
  #picked = 0;
  #pickedFor = "";
  #dismissed: string | undefined;
  #modal: Modal | undefined;
  #back = 0;
  #previous: string[] = [];
  #frame: ReturnType<typeof setTimeout> | undefined;
  #escape: ReturnType<typeof setTimeout> | undefined;

  constructor(options: TuiOptions) { this.#o = options; }

  get active(): boolean { return this.#active; }
  get cols(): number { return this.#o.output.columns || 80; }
  get rows(): number { return this.#o.output.rows || 24; }

  start(): void {
    if (this.#active) return;
    this.#active = true;
    const { input, output } = this.#o;
    output.write(`${ENTER}${this.#o.mouse ? MOUSE_ON : ""}`);
    input.setRawMode?.(true);
    input.setEncoding("utf8");
    input.resume();
    input.on("data", this.#onData);
    output.on("resize", this.#onResize);
    process.once("exit", this.#restore);
    this.#draw(true);
  }

  stop(): void {
    if (!this.#active) return;
    this.#active = false;
    const { input, output } = this.#o;
    input.off("data", this.#onData);
    output.off("resize", this.#onResize);
    process.off("exit", this.#restore);
    clearTimeout(this.#frame);
    clearTimeout(this.#escape);
    input.setRawMode?.(false);
    input.pause();
    this.#restore();
    this.#end();
  }

  /** Add output to the conversation. */
  write(text: string): void {
    const before = this.#back > 0 ? this.transcript.totalRows(this.cols) : 0;
    this.transcript.write(text);
    if (this.#back > 0) this.#back += this.transcript.totalRows(this.cols) - before;
    this.#schedule();
  }

  /** Empty the conversation, for a fresh welcome screen. */
  /** Show these lines under the conversation until they are replaced; an empty list takes them away. */
  setLive(lines: readonly string[]): void { this.transcript.setLive(lines); this.#schedule(); }

  clearConversation(): void { this.transcript.clear(); this.#back = 0; this.#schedule(); }

  setPrompt(prompt: string, placeholder = ""): void {
    this.#prompt = prompt;
    this.#placeholder = placeholder;
    this.#schedule();
  }

  setStatus(status: () => string): void { this.#status = status; this.#schedule(); }

  setSuggest(suggest: Suggest | undefined): void { this.#suggest = suggest; }
  setEcho(echo: ((line: string) => string | undefined) | undefined): void { this.#echo = echo; }
  setChips(chips: ((text: string) => Chip[]) | undefined): void { this.#chips = chips; }

  refresh(): void { this.#schedule(); }

  onIdleKey(handler: (key: IdleKey) => void): () => void { this.#idleKeys.add(handler); return () => { this.#idleKeys.delete(handler); }; }

  onInterrupt(handler: () => void): () => void { this.#interrupts.add(handler); return () => { this.#interrupts.delete(handler); }; }

  /** Lines the person submits, in order. Ends when the input closes. */
  lines(): AsyncIterable<string> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: async (): Promise<IteratorResult<string>> => {
          while (!this.#queue.length && !this.#ended) await new Promise<void>((resolve) => { this.#waiting = resolve; });
          return this.#queue.length ? { value: this.#queue.shift()!, done: false } : { value: undefined, done: true };
        },
        return: async (): Promise<IteratorResult<string>> => { this.#end(); return { value: undefined, done: true }; },
      }),
    };
  }

  choose(title: string, items: Choice[], initial = 0, frame: Frame = {}, watch?: Watch): Promise<number | "back" | undefined> {
    return new Promise((resolve) => {
      const modal: Modal & { kind: "menu" } = { kind: "menu", menu: new Menu(title, items, initial, this.#o.color, frame), done: (value: number | "back" | undefined) => { clearInterval(modal.timer); resolve(value); } };
      this.#modal = modal;
      if (watch) {
        let busy = false;
        modal.timer = setInterval(() => {
          if (busy || this.#modal !== modal) return;
          busy = true;
          void watch.next().then((update) => {
            if (!update || this.#modal !== modal) return;
            if (update.auto !== undefined) { this.#modal = undefined; modal.done(update.auto); this.#schedule(); return; }
            modal.menu = new Menu(title, update.items ?? modal.menu.items, update.at ?? modal.menu.selected, this.#o.color, update.frame ?? modal.menu.frame);
            this.#schedule();
          }).catch(() => undefined).finally(() => { busy = false; });
        }, watch.everyMs);
      }
      this.#schedule();
    });
  }

  /** A hidden field for a pasted key. */
  secret(title: string, frame: Frame = {}): Promise<string | "back" | undefined> {
    return new Promise((done) => {
      this.#modal = { kind: "secret", secret: new Secret(title, this.#o.color, false, "", frame), done };
      this.#schedule();
    });
  }

  /** A visible field for a short answer; `initial` is offered and can be edited. */
  text(title: string, initial = "", frame: Frame = {}): Promise<string | "back" | undefined> {
    return new Promise((done) => {
      this.#modal = { kind: "secret", secret: new Secret(title, this.#o.color, true, initial, frame), done };
      this.#schedule();
    });
  }

  /** A screen that waits for `task` while showing its progress. Esc cancels it, Left goes back; the task is told to stop. */
  work<T>(title: string, frame: Frame, task: (context: WorkContext) => Promise<T>): Promise<T | "back" | undefined> {
    return new Promise((resolve, reject) => {
      const controller = new AbortController();
      const modal: Modal = { kind: "work", title, frame, log: [], stop: (outcome) => { controller.abort(); this.#finish(modal); resolve(outcome); } };
      this.#modal = modal;
      this.#schedule();
      task({ signal: controller.signal, log: (line) => { modal.log.push(line); if (modal.log.length > 50) modal.log.shift(); this.#schedule(); } }).then(
        (value) => { if (this.#modal === modal) { this.#finish(modal); resolve(value); } },
        (error: unknown) => { if (this.#modal === modal) { this.#finish(modal); reject(error); } },
      );
    });
  }

  /** A full-screen, read-only page of text that follows the end while it grows; arrows, PageUp/PageDown, Home and End scroll; Esc, q, Enter or Ctrl+O close it. */
  view(title: string, source: () => string[]): Promise<void> {
    if (this.#modal) return Promise.resolve();
    return new Promise((resolve) => {
      const modal: Modal & { kind: "view" } = { kind: "view", title, source, at: "end", done: () => { clearInterval(modal.timer); resolve(); } };
      modal.timer = setInterval(() => { if (this.#modal === modal) this.#schedule(); }, 250);
      this.#modal = modal;
      this.#schedule();
    });
  }

  #viewRows(modal: Modal & { kind: "view" }): { rows: string[]; top: number; room: number; total: number } {
    const lines = modal.source().flatMap((l) => wrap(l, Math.max(20, this.cols - 4)));
    // The page gets the rows above the input box, less the blank line before it, the title, and the blank line and key hints after the text.
    const room = Math.max(3, viewportRows(this.rows, this.#layout().rows.length) - 5);
    const last = Math.max(0, lines.length - room);
    const top = modal.at === "end" ? last : Math.min(modal.at, last);
    return { rows: lines.slice(top, top + room), top, room, total: lines.length };
  }

  #viewOverlay(modal: Modal & { kind: "view" }): string[] {
    const c = this.#o.color;
    const { rows, top, room, total } = this.#viewRows(modal);
    const where = total <= room ? "" : top + room >= total ? "  end" : `  ${Math.round(((top + room) / total) * 100)}%`;
    return [paint(c, "bold", `  ${modal.title}`) + paint(c, "faint", where), "", ...rows.map((r) => `  ${r}`), "", `  ${keyHints([["↑↓ PgUp PgDn", "scroll"], ["Esc", "close"]], c)}`];
  }

  #viewKey(modal: Modal & { kind: "view" }, key: Key): void {
    const close = (): void => { this.#modal = undefined; modal.done(); };
    const { top, room, total } = this.#viewRows(modal);
    const last = Math.max(0, total - room);
    const go = (to: number): void => { modal.at = to >= last ? "end" : Math.max(0, to); };
    if (key.kind === "wheel") { go(top + (key.direction === "up" ? -WHEEL_ROWS : WHEEL_ROWS)); return; }
    if (key.kind === "ctrl") { if (key.letter === "o" || key.letter === "c" || key.letter === "d") close(); return; }
    if (key.kind === "text") { if (key.text === "q") close(); else if (key.text === "g") go(0); else if (key.text === "G") go(last); else if (key.text === "j") go(top + 1); else if (key.text === "k") go(top - 1); return; }
    if (key.kind !== "key") return;
    switch (key.name) {
      case "escape": case "enter": close(); break;
      case "up": go(top - 1); break;
      case "down": go(top + 1); break;
      case "pageup": go(top - (room - 1)); break;
      case "pagedown": case "right": go(top + (room - 1)); break;
      case "home": go(0); break;
      case "end": go(last); break;
      default: break;
    }
  }

  #finish(modal: Modal): void {
    if (this.#modal === modal) this.#modal = undefined;
    this.#schedule();
  }

  readonly #restore = (): void => {
    this.#o.output.write(`${this.#o.mouse ? MOUSE_OFF : ""}${LEAVE}`);
  };

  #end(): void { this.#ended = true; this.#waiting?.(); }

  readonly #onResize = (): void => { this.#draw(true); };

  readonly #onData = (chunk: Buffer | string): void => {
    const text = String(chunk);
    clearTimeout(this.#escape);
    for (const key of this.#parser.push(text)) this.#handle(key);
    if (text.endsWith("\u001b")) this.#escape = setTimeout(() => { for (const key of this.#parser.flush()) this.#handle(key); }, 30);
  };

  #scroll(rows: number): void {
    const view = viewportRows(this.rows, this.#layout().rows.length);
    this.#back = Math.min(Math.max(0, this.#back + rows), this.transcript.maxBack(this.cols, view));
  }

  #page(): number { return Math.max(1, viewportRows(this.rows, this.#layout().rows.length) - 2); }

  #handle(key: Key): void {
    if (this.#modal) { this.#modalKey(key); this.#schedule(); return; }
    if (key.kind === "wheel") { this.#scroll(key.direction === "up" ? WHEEL_ROWS : -WHEEL_ROWS); this.#schedule(); return; }
    if (key.kind === "key" && (key.name === "pageup" || key.name === "pagedown" || (key.shift && (key.name === "up" || key.name === "down")))) {
      const step = key.shift && (key.name === "up" || key.name === "down") ? 1 : this.#page();
      this.#scroll(key.name === "pageup" || key.name === "up" ? step : -step);
      this.#schedule();
      return;
    }
    if (key.kind === "ctrl" && key.letter === "l") { this.#draw(true); return; }
    if (key.kind === "ctrl" && key.letter === "o") { for (const handler of [...this.#idleKeys]) handler("ctrl-o"); this.#schedule(); return; }
    if (this.#suggestionKey(key)) { this.#schedule(); return; }

    const before = this.#editor.text;
    const result = this.#editor.apply(key);
    if (result.interrupt) for (const handler of [...this.#interrupts]) handler();
    else if (result.eof) this.#end();
    else if (result.submit !== undefined) this.#submit(result.submit);
    else if (!result.handled && key.kind === "key") this.#idle(key);
    if (this.#editor.text !== before) { this.#dismissed = undefined; this.#back = 0; }
    this.#schedule();
  }

  #idle(key: Extract<Key, { kind: "key" }>): void {
    if (key.name === "escape") {
      if (this.#back > 0) { this.#back = 0; return; }
      for (const handler of [...this.#idleKeys]) handler("escape");
    } else if (key.name === "tab" && key.shift) {
      for (const handler of [...this.#idleKeys]) handler("shift-tab");
    }
  }

  #submit(line: string): void {
    this.#dismissed = undefined;
    this.#back = 0;
    if (line.trim()) { const shown = this.#echo ? this.#echo(line) : `${this.#prompt}${line}\n`; if (shown) this.write(shown); }
    this.#queue.push(line);
    this.#waiting?.();
  }

  #modalKey(key: Key): void {
    const modal = this.#modal!;
    if (modal.kind === "view") { this.#viewKey(modal, key); return; }
    if (modal.kind === "work") {
      if (key.kind === "ctrl" && (key.letter === "c" || key.letter === "d")) modal.stop(undefined);
      else if (key.kind === "key" && key.name === "escape") modal.stop(undefined);
      else if (key.kind === "key" && (key.name === "left" || key.name === "backspace")) modal.stop("back");
      else if (key.kind === "text") modal.frame.actions?.find((a) => a.key.toLowerCase() === key.text.toLowerCase())?.run();
      return;
    }
    if (modal.kind === "menu") {
      const outcome = modal.menu.apply(key);
      if (!outcome) return;
      this.#modal = undefined;
      modal.done("done" in outcome ? outcome.done : "back" in outcome ? "back" : undefined);
      return;
    }
    const outcome = modal.secret.apply(key);
    if (!outcome) return;
    this.#modal = undefined;
    modal.done("done" in outcome ? outcome.done : "back" in outcome ? "back" : undefined);
  }

  #suggestions(): { from: number; items: Suggestion[] } | undefined {
    const found = !this.#suggest || this.#dismissed === this.#editor.text ? undefined : this.#suggest(this.#editor.text, this.#editor.cursor);
    if (!found?.items.length) { this.#pickedFor = ""; return undefined; }
    const signature = found.items.map((s) => s.label).join("\n");
    if (signature !== this.#pickedFor) { this.#pickedFor = signature; this.#picked = 0; }
    this.#picked = Math.min(this.#picked, found.items.length - 1);
    return found;
  }

  /** Arrow, Tab, Enter and Escape belong to the list of suggestions while one is open. */
  #suggestionKey(key: Key): boolean {
    const open = this.#suggestions();
    if (!open || key.kind !== "key") return false;
    const count = open.items.length;
    if (key.name === "up" && !key.shift) { this.#picked = (this.#picked + count - 1) % count; return true; }
    if (key.name === "down" && !key.shift) { this.#picked = (this.#picked + 1) % count; return true; }
    if (key.name === "escape") { this.#dismissed = this.#editor.text; return true; }
    if (key.name !== "tab" && !(key.name === "enter" && !key.alt && !key.shift)) return false;
    if (key.name === "tab" && key.shift) return false;
    const item = open.items[this.#picked]!;
    const text = this.#editor.text.slice(0, open.from) + item.insert;
    if (key.name === "enter" && item.run) { this.#editor.setText(text); this.#submit(text); this.#editor.remember(text); this.#editor.clear(); return true; }
    this.#editor.setText(text);
    this.#back = 0;
    return true;
  }

  #layout(): ReturnType<LineEditor["layout"]> {
    const c = this.#o.color;
    return this.#editor.layout(this.#prompt, visibleWidth(this.#prompt), this.cols, this.#placeholder, (t) => paint(c, "faint", t));
  }

  #schedule(): void {
    if (!this.#active || this.#frame) return;
    this.#frame = setTimeout(() => { this.#frame = undefined; this.#draw(false); }, 8);
  }

  #draw(full: boolean): void {
    if (!this.#active) return;
    const c = this.#o.color;
    const cols = this.cols, rows = this.rows;
    const modal = this.#modal;
    const open = modal ? undefined : this.#suggestions();
    const view = viewportRows(rows, this.#layout().rows.length);
    const chips = modal || open || !this.#chips ? [] : chipLines(this.#chips(this.#editor.text), cols, c);
    const overlay = modal
      ? ["", ...(modal.kind === "menu" ? modal.menu.lines(cols, Math.max(5, rows - 6)) : modal.kind === "secret" ? modal.secret.lines(cols) : modal.kind === "view" ? this.#viewOverlay(modal) : workLines(modal.title, modal.frame, modal.log, cols, c))]
      : open ? suggestionLines(open.items, this.#picked, cols, Math.min(PALETTE_ROWS, view), c) : chips.length ? chips : undefined;
    const rule = paint(c, "faint", "─".repeat(cols));
    const frame = composeFrame({
      cols, rows, transcript: this.transcript, back: this.#back, input: this.#layout(), status: this.#status(),
      ...(overlay ? { overlay } : {}), ...(modal ? { modal: true } : {}), rule,
      scrolledRule: scrolledRule(cols, c),
    });
    let out = "";
    if (full || this.#previous.length !== frame.rows.length) out += "\u001b[2J";
    frame.rows.forEach((row, i) => {
      if (full || this.#previous[i] !== row) out += `\u001b[${i + 1};1H\u001b[2K${row}\u001b[0m`;
    });
    this.#previous = frame.rows;
    out += frame.cursor ? `\u001b[${frame.cursor.row + 1};${frame.cursor.col + 1}H\u001b[?25h` : "\u001b[?25l";
    this.#o.output.write(`\u001b[?2026h${out}\u001b[?2026l`);
  }
}
