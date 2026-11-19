/** Everything the CLI touches in the outside world, in one injectable shape (so commands run unchanged in tests). */
import { LineSplitter } from "@navvied/protocol";
import type { Env } from "./config.ts";
import { realSystem, type System } from "./system.ts";
import { runInline } from "./tui/inline.ts";
import { Menu, Secret, workLines, type Choice, type Frame, type Suggest, type Watch, type WorkContext } from "./tui/menu.ts";
import { Tui } from "./tui/terminal.ts";

export type { Choice, Frame, Watch, WorkContext } from "./tui/menu.ts";

export interface Dock {
  refresh(): void;
  /** Empty the conversation. */
  clear(): void;
  release(): void;
}

export interface LineOptions {
  /** Suggestions for what is being typed: commands after a slash, files after an at sign. */
  suggest?: Suggest;
  /** What to show in the conversation for a line the person submitted: nothing, or text. Without it the line is shown as typed, after the prompt. */
  echo?: (line: string) => string | undefined;
}

export interface IO {
  stdout: { write(text: string): void };
  stderr: { write(text: string): void };
  stdin: AsyncIterable<string>;
  /** Standard input and output are a terminal (a person is present). */
  interactive: boolean;
  color: boolean;
  env: Env;
  /** Called on Ctrl+C. Returns a function that removes the handler. */
  onInterrupt(handler: () => void): () => void;
  /** Lines the user types. In the whole-screen interface: editing, history and suggestions. */
  lines(options?: LineOptions): AsyncIterable<string>;
  /** A menu: move with the arrow keys (or a number), confirm with Enter, go back with Left, cancel with Esc. Resolves to the chosen index, "back", or undefined if cancelled. Absent when there is no terminal. */
  choose?(title: string, items: Choice[], initial?: number, frame?: Frame, watch?: Watch): Promise<number | "back" | undefined>;
  /** Read a secret (a pasted key) without echoing it. Resolves to the text, "back", or undefined if cancelled. */
  secret?(prompt: string, frame?: Frame): Promise<string | "back" | undefined>;
  /** Ask for a short answer, offering `initial`. Resolves to the text, "back", or undefined if cancelled. */
  text?(title: string, initial?: string, frame?: Frame): Promise<string | "back" | undefined>;
  /** A screen that waits for `task` and shows its progress. Resolves to the task's result, "back", or undefined if cancelled. */
  work?<T>(title: string, frame: Frame, task: (context: WorkContext) => Promise<T>): Promise<T | "back" | undefined>;
  /** Keys that work while the app is open: Shift+Tab and Esc. Returns a function that stops listening. */
  keys?(handler: (key: "shift-tab" | "escape" | "ctrl-o") => void): () => void;
  /** A full-screen page of text to read and scroll (Ctrl+O shows the steps this way). `source` is read again while the page is open, so it follows work that is still going on. Absent without a whole-screen interface. */
  view?(title: string, source: () => string[]): Promise<void>;
  /** Open the whole-screen interface with a status line at the bottom. Undefined when the terminal cannot. */
  dock?(status: () => string): Dock | undefined;
  /** Lines shown under the conversation while work is going on (a spinner, the next message); an empty list removes them. Absent when there is no whole-screen interface. */
  live?(lines: readonly string[]): void;
  /** Show the input prompt, and the grey hint shown while nothing is typed (a no-op when nobody is typing). */
  prompt(text: string, placeholder?: string): void;
  /** Clipboard, browser and programs on this computer. */
  system: System;
  fetch: typeof fetch;
}

const MIN_ROWS = 8;

export function processIO(): IO {
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const handlers = new Set<() => void>();
  const fire = (): void => { for (const h of [...handlers]) h(); };
  process.on("SIGINT", fire);
  const color = Boolean(process.stderr.isTTY) && process.env.NO_COLOR === undefined;
  let tui: Tui | undefined;
  const live = (): Tui | undefined => (tui?.active ? tui : undefined);

  const stdin = (async function* () {
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) yield chunk as string;
  })();
  const plainLines = (): AsyncIterable<string> => (async function* () {
    const split = new LineSplitter();
    for await (const c of stdin) yield* split.push(c);
    yield* split.flush();
  })();

  return {
    stdout: { write: (text) => { const t = live(); if (t) t.write(text); else process.stdout.write(text); } },
    stderr: { write: (text) => { const t = live(); if (t) t.write(text); else process.stderr.write(text); } },
    stdin,
    interactive,
    color,
    env: process.env,
    system: realSystem(process.env),
    fetch: globalThis.fetch,
    onInterrupt(handler) {
      handlers.add(handler);
      return () => { handlers.delete(handler); };
    },
    lines(options) {
      const t = live();
      if (!t) return plainLines();
      t.setSuggest(options?.suggest);
      t.setEcho(options?.echo);
      return t.lines();
    },
    choose: interactive ? (title, items, initial = 0, frame = {}, watch) => {
      const t = live();
      if (t) return t.choose(title, items, initial, frame, watch);
      const menu = new Menu(title, items, initial, color, frame);
      return runInline(process.stdin, process.stderr, (cols) => menu.lines(cols, Math.max(MIN_ROWS, (process.stderr.rows ?? 24) - 2)), (key) => {
        const outcome = menu.apply(key);
        if (!outcome) return undefined;
        return "done" in outcome ? outcome.done : "back" in outcome ? ("back" as const) : null;
      }).then((value) => value ?? undefined);
    } : undefined,
    text: interactive ? (title, initial = "", frame = {}) => {
      const t = live();
      if (t) return t.text(title, initial, frame);
      const field = new Secret(title, color, true, initial, frame);
      return runInline(process.stdin, process.stderr, (cols) => field.lines(cols), (key) => {
        const outcome = field.apply(key);
        if (!outcome) return undefined;
        return "done" in outcome ? outcome.done : "back" in outcome ? ("back" as const) : null;
      }).then((value) => value ?? undefined);
    } : undefined,
    secret: interactive ? (title, frame = {}) => {
      const t = live();
      if (t) return t.secret(title, frame);
      const secret = new Secret(title, color, false, "", frame);
      return runInline(process.stdin, process.stderr, (cols) => secret.lines(cols), (key) => {
        const outcome = secret.apply(key);
        if (!outcome) return undefined;
        return "done" in outcome ? outcome.done : "back" in outcome ? ("back" as const) : null;
      }).then((value) => value ?? undefined);
    } : undefined,
    work: interactive ? (async <T>(title: string, frame: Frame, task: (context: WorkContext) => Promise<T>) => {
      const t = live();
      if (t) return t.work(title, frame, task);
      process.stderr.write(`${workLines(title, frame, [], process.stderr.columns ?? 80, color).slice(0, -1).join("\n")}\n`);
      return task({ signal: new AbortController().signal, log: (line) => { process.stderr.write(`    ${line}\n`); } });
    }) as IO["work"] : undefined,
    keys: interactive ? (handler) => live()?.onIdleKey(handler) ?? (() => {}) : undefined,
    view: interactive ? (title, source) => live()?.view(title, source) ?? Promise.resolve() : undefined,
    dock(status) {
      if (!interactive || (process.stdout.rows ?? 0) < MIN_ROWS || process.env.TERM === "dumb") return undefined;
      tui ??= new Tui({ input: process.stdin, output: process.stdout, color, mouse: process.env.NAVVIED_NO_MOUSE === undefined });
      tui.onInterrupt(fire);
      tui.setStatus(status);
      tui.start();
      const t = tui;
      return { refresh: () => { t.refresh(); }, clear: () => { t.clearConversation(); }, release: () => { t.stop(); } };
    },
    live(lines) { live()?.setLive(lines); },
    prompt(text, placeholder = "") {
      const t = live();
      if (t) t.setPrompt(text, placeholder);
      else if (interactive) process.stderr.write(text);
    },
  };
}
