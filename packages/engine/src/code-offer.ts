/**
 * When the script tool is worth its place in the tool list. With its switch on it is not offered on the first request of a turn (its text
 * would be paid on every request, used or not). It comes in for one of two reasons, both decided here without any model:
 *  - the request shows up front that the work is many repeated steps (`asksForMany`: numbers and addresses, never words), or
 *  - the turn has already moved a lot of data through the conversation call by call (`CodeOffer.count`), and the tool is offered from the
 *    next step with a note on the result that tells the model what it would have saved.
 */

export interface CodeAfter {
  /** Calls of the data-moving kinds in one turn. */
  calls: number;
  /** Characters those calls returned in one turn. */
  chars: number;
  /** Lines of those results in one turn: many short lines (a list of files) are as much to count by eye as a few long ones. */
  lines?: number;
}
export const CODE_AFTER: CodeAfter = { calls: 6, chars: 20_000, lines: 60 };

/** The calls whose results are data the model only has to filter: files, search hits, pages and what a connected program returns. Bash is left out: it can already write its own loop. */
const MOVES = new Set(["Read", "Grep", "Glob", "WebFetch", "WebSearch"]);
export const movesData = (tool: string): boolean => MOVES.has(tool) || tool.startsWith("mcp__");

/** The note on the result that crosses a limit: what has gone through the conversation, and the way out. */
export const codeNote = (calls: number, chars: number): string =>
  `That is ${calls} call${calls === 1 ? "" : "s"} and ${chars.toLocaleString("en-US")} characters through the conversation: ExecuteCode runs them as one script and prints only what you need.`;

/**
 * Counts the data-moving calls of one turn. Deterministic: only the number of calls and the length of their results, so a test with a
 * scripted model decides exactly when the note appears and the tool is offered.
 */
export class CodeOffer {
  #calls = 0;
  #chars = 0;
  #lines = 0;
  #told = false;
  #open = false;
  #asked = false;
  #fresh = false;

  constructor(private readonly after: CodeAfter = CODE_AFTER, private readonly always = false) {}

  /** A new turn: the counters start again, and the request is read for cues. */
  begin(request: string): void {
    this.#calls = 0; this.#chars = 0; this.#lines = 0; this.#told = false; this.#open = false; this.#fresh = false;
    this.#asked = asksForMany(request);
  }

  /** Whether the tool is offered in this step. */
  get offered(): boolean { return this.always || this.#open || this.#asked; }

  /** One finished call. The first time a limit is reached the tool is offered from then on, and `note` has the words for the model. */
  count(tool: string, result: string): void {
    if (!movesData(tool)) return;
    this.#calls++; this.#chars += result.length; this.#lines += result.split("\n").length;
    if (this.#told || (this.#calls < this.after.calls && this.#chars < this.after.chars && this.#lines < (this.after.lines ?? Infinity))) return;
    this.#told = true;
    if (!this.offered) { this.#open = true; this.#fresh = true; }
  }

  /** The note for the end of a step in which a limit was reached, with the whole step counted; once. */
  note(): string | undefined {
    if (!this.#fresh) return undefined;
    this.#fresh = false;
    return codeNote(this.#calls, this.#chars);
  }
}

/** A whole number of 10 to 999,999 standing alone: not a version, a time, a size with its unit, a decimal, or a year. */
const NUMBER = /(?<![\p{L}\p{N}._:/\-#@$+])(\d{2,6})(?![\p{L}\p{N}_:/\-%]|[.,]\d)/gu;
const PATHLIKE = /(?:https?:\/\/\S+|(?:\.{0,2}\/)?[\w.-]+(?:\/[\w.*-]+)+|[\w-]+\.[a-z]{1,5}\b)/gi;
const WILDCARD = /\S*\*\S*[./]\S*|\S*[./]\S*\*\S*/;
const MANY_ITEMS = 10;
const SOME_ITEMS = 3;

/**
 * Whether a request shows up front that it is many repeated steps. It reads only what is the same in every language and every way of writing:
 *  - a number of 10 or more (not a year, version, time, decimal or size) together with a wildcard path or at least 3 files or addresses named, or
 *  - 10 or more different files or addresses named.
 * A request with no number, wildcard or address is not caught here; the counters of the turn catch it.
 */
export function asksForMany(request: string): boolean {
  const items = new Set((request.match(PATHLIKE) ?? []).map((s) => s.replace(/[.,;:)]+$/, "")));
  if (items.size >= MANY_ITEMS) return true;
  const big = [...request.matchAll(NUMBER)].some((m) => { const n = Number(m[1]); return n >= 10 && !(n >= 1900 && n <= 2100); });
  return big && (WILDCARD.test(request) || items.size >= SOME_ITEMS);
}
