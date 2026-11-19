import type { EditorLayout } from "./editor.ts";
import type { Transcript } from "./transcript.ts";
import { clip } from "./wrap.ts";

export interface FrameInput {
  cols: number;
  rows: number;
  transcript: Transcript;
  /** Rows scrolled back from the newest output; 0 follows the output. */
  back: number;
  input: EditorLayout;
  status: string;
  /** Lines drawn over the bottom of the conversation (a list of suggestions), or, with `modal`, instead of it (a menu). */
  overlay?: string[];
  /** A menu owns the keyboard, so the text cursor is hidden. */
  modal?: boolean;
  rule: string;
  /** The rule shown instead while scrolled back, saying how to return. */
  scrolledRule: string;
}

export interface Frame {
  rows: string[];
  /** Zero-based screen position of the text cursor, or none. */
  cursor?: { row: number; col: number };
}

/** The most input rows shown at once; a longer text scrolls inside its box. */
export const maxInputRows = (rows: number): number => Math.max(1, Math.min(6, Math.floor((rows - 4) / 2)));

/** Rows the conversation gets once the input box, its two rules and the status line are placed. */
export function viewportRows(rows: number, inputRows: number): number {
  return Math.max(1, rows - (Math.min(inputRows, maxInputRows(rows)) + 3));
}

/** Lays out one whole screen: conversation, rule, input, rule, status. Pure, so it can be tested without a terminal. */
export function composeFrame(f: FrameInput): Frame {
  const limit = maxInputRows(f.rows);
  const shownInput = Math.min(f.input.rows.length, limit);
  const first = Math.min(Math.max(0, f.input.cursor.row - shownInput + 1), f.input.rows.length - shownInput);
  const view = viewportRows(f.rows, f.input.rows.length);
  let body: string[];
  if (f.modal) {
    const panel = (f.overlay ?? []).slice(0, view);
    body = [...panel, ...Array<string>(view - panel.length).fill("")];
  } else {
    body = f.transcript.view(f.cols, view, f.back);
    if (f.overlay?.length) {
      const lines = f.overlay.slice(-view);
      body.splice(view - lines.length, lines.length, ...lines);
    }
  }
  const rows = [
    ...body.map((r) => clip(r, f.cols)),
    clip(f.back > 0 ? f.scrolledRule : f.rule, f.cols),
    ...f.input.rows.slice(first, first + shownInput).map((r) => clip(r, f.cols)),
    clip(f.rule, f.cols),
    clip(f.status, f.cols),
  ];
  return { rows: rows.slice(0, f.rows), ...(f.modal ? {} : { cursor: { row: view + 1 + (f.input.cursor.row - first), col: Math.min(f.input.cursor.col, f.cols - 1) } }) };
}
