/**
 * Shows the conversation the way a person reads it: their own message in a block, what the agent does as short steps in plain
 * words, changes as tinted lines, the answer as formatted text, and while it works a live line saying what it is doing.
 * It replaces the plain stream of the renderer in the interactive app; the renderer still serves `run` and piped output.
 */
import type { EngineEvent, FileNote } from "@navvied/protocol";
import { mark } from "./banner.ts";
import { refusalWords } from "./screen-words.ts";
import { SavedFiles, savedFile } from "./saved-files.ts";
import type { IO } from "./io.ts";
import { Markdown } from "./markdown.ts";
import { paint, retryLine, type Renderer } from "./render.ts";
import { describeFailure, describeStep, diffRows, failed, parseBashOutput, shortPath, startLine, stepTail, type Step } from "./steps.ts";
import { currentTheme, fgRgb, surfaces } from "./theme.ts";
import { diffLines } from "./diff-view.ts";

const RESET = "\u001b[0m";
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const TICK_MS = 120;
const MAX_QUEUE_SHOWN = 3;
const PREVIEW_LINES = 2;
const MAX_GROUP_SHOWN = 8;
const MAX_PLAN_SHOWN = 8;
/** Separates short facts on one line (a time, a count) without looking like a generated "a · b · c" list. */
const SEP = "   ";

/**
 * What the engine says when a model fails to answer is written for a log, not for a person ("the model endpoint answered 401",
 * a raw "fetch failed"). This turns the shapes navvied knows about into a plain sentence with something to do next; anything
 * else is shown as it came, with its first letter capitalised, so it still reads as a sentence.
 */
export function plainModelError(msg: string): string {
  if (/fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|network/i.test(msg)) return "Could not reach the model. Check that it is running, and your internet connection.";
  if (/answered 401|answered 403/.test(msg)) return "The model did not accept the key it was given. Check it, or run /model to connect a different one.";
  if (/answered 5\d\d/.test(msg)) return "The model did not answer properly just now. Try again in a moment.";
  if (/returned an empty answer/.test(msg)) return "The model sent back nothing. Try again, or run /model to choose another one.";
  return msg ? msg.charAt(0).toUpperCase() + msg.slice(1) : msg;
}

/** What the engine made of a picture or a file attached to the message, one line each; a picture is only ever a count. */
function attachmentLines(images: number | undefined, files: FileNote[] | undefined, color: boolean): string[] {
  const lines: string[] = [];
  if (images) lines.push(paint(color, "dim", `${images} picture${images === 1 ? "" : "s"} attached`));
  for (const f of files ?? []) {
    const pages = f.pages ? ` (${f.pages} page${f.pages === 1 ? "" : "s"})` : "";
    const note = f.note ? ` — ${f.note}` : "";
    const rest = paint(color, "dim", `${f.name}${pages}${note}`);
    lines.push(f.kind === "refused" ? `${paint(color, "red", "✗")} ${rest}` : rest);
  }
  return lines;
}

export interface PresenterOptions {
  cwd: () => string;
  /** Show the model's own reasoning text as it arrives. */
  thinking: boolean;
  width?: () => number;
  now?: () => number;
  /** Calls `fn` every `ms` until the returned function is called. */
  every?: (ms: number, fn: () => void) => () => void;
  /** `list` (default, as in the web UI): every step stays as one line, and only a step that went wrong or changed a file shows more. `fold`: the steps that went well are folded into the header. `all`: every step shows everything it printed. */
  steps?: "list" | "fold" | "all";
  /** What the person typed for a message, when the engine was given more than that (files that were attached). */
  display?: (qid: string) => string | undefined;
}

interface Running { name: string; input: unknown; step: Step | undefined; /** The last lines a running command printed. */ out: string[]; started: number }

/** How long, for a person: 0.4 s, 12 s, 2 m 5 s. */
export const took = (ms: number): string => (ms < 100 ? "<0.1 s" : ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.floor(ms / 60_000)} m ${Math.round((ms % 60_000) / 1000)} s`);

const plain = (s: string): number => [...s.replace(/\u001b\[[0-9;]*m/g, "")].length;

const defaultEvery = (ms: number, fn: () => void): (() => void) => {
  const timer = setInterval(fn, ms);
  timer.unref?.();
  return () => clearInterval(timer);
};

export class Presenter {
  readonly #running = new Map<string, Running>();
  readonly #queue: { qid: string; text: string }[] = [];
  #markdown: Markdown;
  #partial = "";
  #usage: { ctx: number; win: number } | undefined;
  #turnStart: number | undefined;
  #markShown = false;
  #thoughtStart: number | undefined;
  #label = "";
  #frame = 0;
  #stopTimer: (() => void) | undefined;
  #lastTool: { name: string; input: unknown } | undefined;
  /** The application the last look at the screen named: a click or a key does not name one. */
  #app = "";
  /** The files this conversation made, for `/open`. */
  readonly files = new SavedFiles();
  /** Steps asked for in the same go as one that is running: they wait their turn. */
  readonly #waiting = new Map<string, { name: string; input: unknown }>();
  /** What the steps of this turn came to, for the line that closes it. */
  #counts = { commands: 0, reads: 0, edits: 0, failed: 0, denied: 0, timeout: 0, background: 0 };
  /** The agent's own task list, shown under the working line and changed in place. */
  #plan: { title: string; status: string }[] = [];
  /** Steps finished in this turn, for the working line. */
  #stepsDone = 0;
  /** The model has said or done something this turn: until then the line says it is starting. */
  #started = false;
  /** The steps of the block being shown, as they finish; each is the lines it drew and whether it needs to stay visible. */
  #rows: { lines: string[]; keep: boolean; thought?: boolean }[] = [];
  #pending: string[] = [];
  /** The steps being shown now are in a block of their own (the work), apart from the report the agent writes. */
  #inWork = false;
  #group = { steps: 0, failed: 0, started: 0, commands: 0, reads: 0, edits: 0, timeout: 0, background: 0, denied: 0 };
  /** What each step of the turn did, for `/steps`. */
  #log: { title: string; mark: string; ms?: number; input: string; output: string; notes?: string[] }[] = [];
  /** What was shown last, so a step and a paragraph never touch each other. */
  #last: "none" | "step" | "text" = "none";

  constructor(private readonly io: IO, private readonly fallback: Renderer, private readonly opts: PresenterOptions) {
    this.#markdown = new Markdown(io.color, () => this.#width());
  }

  get usage(): { ctx: number; win: number } | undefined { return this.#usage ?? this.fallback.usage; }

  #lastOutput: { title: string; text: string } | undefined;

  /** Everything the last step that printed anything said, for `/output`. */
  /** Every step of this turn, for `/steps`. */
  get steps(): readonly { title: string; mark: string; ms?: number; input: string; output: string; notes?: string[] }[] { return this.#log; }

  get lastOutput(): { title: string; text: string } | undefined { return this.#lastOutput; }

  /** The step the engine is asking about, so the question can say what it is for. */
  /** The application the agent is using on the screen right now, while a step of it runs (an empty text when it is not named yet). */
  get usingApp(): string | undefined {
    for (const r of this.#running.values()) if (r.name === "Computer") return this.#appOf(r.name, r.input);
    return undefined;
  }
  #appOf(name: string, input: unknown): string {
    const app = name === "Computer" && typeof input === "object" && input !== null ? (input as { app?: unknown }).app : undefined;
    if (typeof app === "string" && app.trim()) this.#app = app.trim();
    return this.#app;
  }
  get pendingTool(): { name: string; input: unknown } | undefined { return this.#lastTool; }

  /** A message the person sent while the agent works: shown under the live line until it is taken in. */
  queue(qid: string, text: string): void {
    this.#queue.push({ qid, text });
    this.#renderLive();
  }

  stop(): void { this.#halt(); this.io.live?.([]); }

  handle(e: EngineEvent): void {
    switch (e.ev) {
      case "user": return this.#user(e);
      case "taken": this.#begin(); return;
      case "text": return this.#text(e.text);
      case "thought": this.#thought(e.text); return;
      case "tool": return this.#tool(e);
      case "approval": case "question": this.#settle(); return;
      // A picker takes these over from the piped renderer's numbered lines; without one (a dumb terminal), that plain listing is still what is shown.
      case "checkpoints": case "restore": this.#settle(); if (!this.io.choose) this.fallback.handle(e); return;
      case "phase": this.#label = e.name === "compacting" ? "Compacting context" : ""; this.#renderLive(); return;
      case "job": return this.#job(e);
      case "plan": this.#plan = e.entries.map((p) => ({ title: p.title, status: p.status })); this.#renderLive(); return;
      case "usage": this.#usage = { ctx: e.ctx, win: e.win }; this.fallback.handle(e); return;
      case "retry": this.#settle(); this.#closeWork(); this.#line(`  ${paint(this.io.color, "dim", retryLine(e))}`); return;
      case "notice": this.#settle(); this.#closeWork(); this.#line(`  ${this.#warn("!")} ${e.msg}`); return;
      case "error": this.#settle(); this.#closeWork(); this.#line(`  ${this.#bad("✗")} ${paint(this.io.color, "bold", plainModelError(e.msg))}`); return;
      case "done": return this.#done(e.stop);
      default: this.#settle(); this.fallback.handle(e);
    }
  }

  #width(): number { return this.opts.width?.() ?? process.stdout.columns ?? 80; }
  #now(): number { return (this.opts.now ?? Date.now)(); }
  #write(text: string): void { this.io.stderr.write(text); }
  get #collapse(): boolean { return this.opts.steps === "list" || this.opts.steps === "fold"; }
  get #fold(): boolean { return this.opts.steps === "fold"; }

  #line(text: string): void {
    // When the steps collapse, what a step draws is kept aside until it is known whether it stays on the screen.
    if (this.#inWork && this.#collapse) { this.#pending.push(text); return; }
    this.#emit(text);
  }

  /** Inside the work block every line carries a quiet rail on the left, so what the agent did is plainly apart from what it says. */
  #emit(text: string): void {
    this.#write(`${this.#inWork && text.startsWith("  ") ? `  ${paint(this.io.color, "faint", "│")} ${text.slice(2)}` : text}\n`);
  }

  /** A step is done drawing: it stays on the screen when it failed or changed something, and is folded into the summary otherwise. */
  #endStep(keep: boolean, thought = false): void {
    if (this.#pending.length) this.#rows.push({ lines: this.#pending, keep, ...(thought ? { thought: true } : {}) });
    this.#pending = [];
  }
  #warn(s: string): string { const t = currentTheme(); return this.io.color ? `${fgRgb(surfaces(t).warn, t.truecolor)}${s}${RESET}` : s; }
  #bad(s: string): string { const t = currentTheme(); return this.io.color ? `${fgRgb(surfaces(t).bad, t.truecolor)}${s}${RESET}` : s; }
  #ok(s: string): string { const t = currentTheme(); return this.io.color ? `${fgRgb(surfaces(t).ok, t.truecolor)}${s}${RESET}` : s; }

  #begin(): void {
    if (this.#turnStart !== undefined) return;
    this.#turnStart = this.#now();
    this.#frame = 0;
    if (this.io.live && !this.#stopTimer) this.#stopTimer = (this.opts.every ?? defaultEvery)(TICK_MS, () => { this.#frame++; this.#renderLive(); });
    this.#renderLive();
  }

  #halt(): void { this.#stopTimer?.(); this.#stopTimer = undefined; }

  #user(e: Extract<EngineEvent, { ev: "user" }>): void {
    const at = this.#queue.findIndex((q) => q.qid === e.qid);
    if (at >= 0) this.#queue.splice(at, 1);
    this.#settle();
    this.#closeWork();
    this.#begin();
    this.#markShown = false;
    this.#last = "none";
    this.#log = [];
    this.#block(this.opts.display?.(e.qid) ?? e.text, e.images, e.files);
    this.#renderLive();
  }

  /** The person's message: the same ❯ as the prompt it was typed at, so it is plainly theirs, then the words indented like everything else. */
  #block(text: string, images?: number, files?: FileNote[]): void {
    const inner = Math.max(20, this.#width() - 4);
    const body: string[] = [];
    for (const raw of text.split("\n")) {
      let rest = raw.replace(/\t/g, "  ");
      while (plain(rest) > inner) {
        const cut = rest.lastIndexOf(" ", inner);
        const at = cut > inner / 3 ? cut : inner;
        body.push(rest.slice(0, at).trimEnd());
        rest = rest.slice(at).trimStart();
      }
      body.push(rest);
    }
    const shown = body.slice(0, 40);
    if (body.length > 40) shown.push(paint(this.io.color, "dim", `… ${body.length - 40} more lines`));
    this.#write("\n");
    this.#line(`  ${paint(this.io.color, "cyan", "❯")} ${paint(this.io.color, "cyan", paint(this.io.color, "bold", "You"))}`);
    for (const r of shown) this.#line(`  ${r}`);
    for (const a of attachmentLines(images, files, this.io.color)) this.#line(`  ${a}`);
    this.#write("\n");
  }

  #prose(row: string): void {
    if (this.#last === "step" && row.trim()) this.#line("");
    this.#line(row);
    if (row.trim()) this.#last = "text";
  }

  /** The start of a step: set apart from a paragraph that came before it. */
  #stepStart(): void {
    if (!this.#inWork) {
      if (!this.#collapse) {
        if (this.#last === "text" || this.#last === "step") this.#line("");
        this.#line(`  ${paint(this.io.color, "yellow", "⚙")} ${paint(this.io.color, "bold", "Work")}  ${paint(this.io.color, "dim", "what it did, step by step (/steps for the details)")}`);
      }
      this.#rows = [];
      this.#pending = [];
      this.#inWork = true;
      this.#markShown = false;
      this.#group = { steps: 0, failed: 0, started: this.#now(), commands: 0, reads: 0, edits: 0, timeout: 0, background: 0, denied: 0 };
    }
    this.#last = "step";
  }

  /** What a block of steps came to, as one plain sentence: "Ran 5 commands, read 1 file, 1 failed". */
  #groupSummary(): string {
    const g = this.#group;
    const parts: string[] = [];
    if (g.commands) parts.push(`${parts.length ? "ran" : "Ran"} ${g.commands} command${g.commands > 1 ? "s" : ""}`);
    if (g.reads) parts.push(`${parts.length ? "read" : "Read"} ${g.reads} file${g.reads > 1 ? "s" : ""}`);
    if (g.edits) parts.push(`${parts.length ? "changed" : "Changed"} ${g.edits} file${g.edits > 1 ? "s" : ""}`);
    if (g.failed) parts.push(`${g.failed} failed`);
    if (g.timeout) parts.push(`${g.timeout} timed out`);
    if (g.denied) parts.push(`${g.denied} declined`);
    if (g.background) parts.push(`${g.background} in the background`);
    return parts.join(", ") || `${g.steps} step${g.steps === 1 ? "" : "s"}`;
  }

  /** `⚙ Work  summary   time   note` on one line: when it would not fit, the last clauses of the summary give way first, so the time and the Ctrl+O note always stay. */
  #header(summary: string, time: string, note: string): string {
    const room = this.#width() - 2 - "⚙ Work  ".length;
    const tail = [time, ...(note ? [note] : [])].join(SEP);
    const clauses = summary.split(", ");
    const build = (n: number): string => [clauses.slice(0, n).join(", "), tail].join(SEP);
    let n = clauses.length;
    while (n > 1 && build(n).length > room) n--;
    let text = build(n);
    if (text.length > room) {
      // Even the first clause alone is too long: it is cut, and the time and the note stay.
      const first = clauses[0]!;
      const space = Math.max(8, room - tail.length - SEP.length - 1);
      text = `${first.length > space ? `${first.slice(0, space - 1)}…` : first}${SEP}${tail}`;
    }
    return `  ${paint(this.io.color, "yellow", "⚙")} ${paint(this.io.color, "bold", "Work")}  ${paint(this.io.color, "dim", text)}`;
  }

  /** The end of the work block: what it came to, before the report begins. */
  #closeWork(): void {
    if (!this.#inWork) return;
    this.#endStep(false);
    const g = this.#group;
    const time = took(this.#now() - g.started);
    if (this.#collapse) {
      // Folded: one line for the whole block, and below it only the steps that need a look.
      this.#inWork = false;
      if (this.#last === "text" || this.#last === "step") this.#emit("");
      const hidden = this.#fold ? this.#rows.filter((r) => !r.keep && !r.thought).length : 0;
      this.#emit(this.#header(this.#groupSummary(), time, hidden ? `${hidden} folded: Ctrl+O` : "Ctrl+O for details"));
      this.#inWork = true;
      for (const row of this.#rows) {
        if (row.keep) for (const l of row.lines) this.#emit(l);
        else if (!this.#fold) this.#emit(row.lines[0]!);
      }
      this.#inWork = false;
    } else {
      this.#inWork = false;
      this.#emit(`  ${paint(this.io.color, "faint", `└ ${this.#groupSummary()}${SEP}${time}`)}`);
    }
    this.#rows = [];
    this.#emit("");
    this.#last = "step";
  }

  #ensureMark(): void {
    this.#closeWork();
    if (this.#markShown) return;
    this.#markShown = true;
    this.#line(`  ${mark(this.io.color)}  ${paint(this.io.color, "bold", "navvied")}`);
  }

  /** Whatever was being shown line by line is closed, so a step or a question starts on a fresh line. */
  #settle(): void {
    this.#endThought();
    if (this.#partial) { for (const row of this.#markdown.push(this.#partial)) this.#prose(row); this.#partial = ""; }
    for (const row of this.#markdown.flush()) this.#prose(row);
  }

  #text(piece: string): void {
    this.#begin();
    this.#started = true;
    this.#endThought();
    this.#ensureMark();
    this.#partial += piece;
    const lines = this.#partial.split("\n");
    this.#partial = lines.pop() ?? "";
    for (const line of lines) for (const row of this.#markdown.push(line)) this.#prose(row);
    this.#renderLive();
  }

  #thought(piece: string): void {
    this.#begin();
    this.#started = true;
    this.#thoughtStart ??= this.#now();
    if (this.opts.thinking) this.#write(paint(this.io.color, "dim", piece));
    this.#label = "Thinking";
    this.#renderLive();
  }

  #endThought(): void {
    if (this.#thoughtStart === undefined) return;
    const seconds = Math.round((this.#now() - this.#thoughtStart) / 1000);
    this.#thoughtStart = undefined;
    this.#label = "";
    if (seconds >= 1) { this.#stepStart(); this.#line(`  ${paint(this.io.color, "dim", `▸ Thought for ${seconds} s`)}`); this.#endStep(false, true); }
  }

  /** A step of a helper: one quiet line under the step that asked, shown when it is done. */
  #nested(e: Extract<EngineEvent, { ev: "tool" }>): void {
    const known = this.#running.get(e.id) ?? { name: e.name, input: undefined, step: undefined, out: [], started: this.#now() };
    this.#running.set(e.id, known);
    if (e.status === "running") {
      if (e.input !== undefined && !known.step) { known.input = e.input; known.step = describeStep(e.name, e.input, this.opts.cwd(), this.#appOf(e.name, e.input)); }
      return;
    }
    this.#running.delete(e.id);
    const step = known.step ?? describeStep(e.name, known.input, this.opts.cwd(), this.#app);
    const bad = e.status === "error" || failed(e.output ?? "");
    this.#line(`    ${paint(this.io.color, "faint", "│")} ${paint(this.io.color, "dim", bad ? describeFailure(e.name, known.input, this.opts.cwd()) : step.done)}`);
  }

  /** One finished step: its mark, what it was, and on the right how long it took and anything worth a note. */
  #row(mark: string, text: string, right: string, notes: string[] = []): void {
    const chips = notes.map((n) => paint(this.io.color, "dim", n)).join(" ");
    const tail = [chips, paint(this.io.color, "faint", right)].filter(Boolean).join("  ");
    const left = `  ${mark} ${text}`;
    const room = this.#width() - plain(left) - plain(tail) - 2;
    this.#line(tail && room > 1 ? `${left}${" ".repeat(room)}${tail}` : tail ? `${left}  ${tail}` : left);
  }

  /** What a step is called when it is described as work that was not done: "Denied: Ran rm -rf dist". */
  #count(name: string): void {
    if (name === "Bash" || name === "WebFetch" || name === "WebSearch" || name === "Browser") { this.#counts.commands++; this.#group.commands++; }
    else if (name === "Read" || name === "Glob" || name === "Grep") { this.#counts.reads++; this.#group.reads++; }
    else if (name === "Edit" || name === "Write" || name === "MultiEdit" || name === "NotebookEdit" || name === "apply_patch") { this.#counts.edits++; this.#group.edits++; }
  }

  #tool(e: Extract<EngineEvent, { ev: "tool" }>): void {
    this.#begin();
    this.#started = true;
    if (e.parent !== undefined) { this.#nested(e); return; }
    if (e.queued) { this.#waiting.set(e.id, { name: e.name, input: e.input }); this.#renderLive(); return; }
    this.#waiting.delete(e.id);
    const known = this.#running.get(e.id) ?? { name: e.name, input: undefined, step: undefined, out: [], started: this.#now() };
    this.#running.set(e.id, known);
    if (e.status === "running") {
      if (e.live !== undefined) {
        // What a command prints while it runs: the last few lines are shown under the line that says what it is doing.
        for (const row of e.live.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "").split("\n")) if (row.trim()) known.out.push(row.trimEnd().slice(0, 200));
        if (known.out.length > 3) known.out.splice(0, known.out.length - 3);
        this.#renderLive();
        return;
      }
      if (e.input !== undefined && !known.step) {
        this.#settle();
        known.input = e.input;
        known.step = describeStep(e.name, e.input, this.opts.cwd(), this.#appOf(e.name, e.input));
        this.#lastTool = { name: e.name, input: e.input };
        this.#label = known.step.running;
        this.#renderLive();
      } else if (e.input !== undefined && known.step && JSON.stringify(e.input) !== JSON.stringify(known.input)) {
        // The person changed the command before allowing it.
        known.input = e.input;
        known.step = describeStep(e.name, e.input, this.opts.cwd(), this.#appOf(e.name, e.input));
        known.out = [];
        (known as Running & { edited?: boolean }).edited = true;
        this.#label = known.step.running;
        this.#renderLive();
      }
      return;
    }
    this.#running.delete(e.id);
    this.#settle();
    this.#stepStart();
    this.#group.steps++;
    const step = known.step ?? describeStep(e.name, known.input ?? e.input, this.opts.cwd(), this.#app);
    const input = known.input ?? e.input;
    const output = e.output ?? "";
    const right = e.ms !== undefined ? took(e.ms) : "";
    // Bash output can carry its own trailing lines (how it went, where it now runs, a background job): taken apart from what the command printed.
    const bash = e.name === "Bash" ? parseBashOutput(output) : undefined;
    const cleanOutput = bash ? bash.lines.join("\n") : output;
    if (output.trim()) this.#lastOutput = { title: step.done, text: cleanOutput };
    const notes = [...(e.truncated ? ["TRUNCATED"] : []), ...((known as Running & { edited?: boolean }).edited ? ["EDITED"] : [])];
    const what = (): string => step.done;
    // A step stays on the screen when something went wrong or when it changed a file: those are what a person needs to see.
    const attention = (e.outcome !== undefined && e.outcome !== "background" && e.outcome !== "skipped" && e.outcome !== "redirected") || e.status === "error" || (e.code !== undefined && e.code !== null && e.code !== 0) || failed(e.output ?? "") || e.screen?.verdict === "refused" || savedFile(e.output ?? "") !== undefined || e.name === "Edit" || e.name === "Write";
    if (e.outcome === "denied") { this.#counts.denied++; this.#group.denied++; this.#row(paint(this.io.color, "dim", "−"), paint(this.io.color, "dim", `You said no: ${what()}`), right, notes); }
    else if (e.outcome === "blocked") {
      this.#counts.failed++; this.#group.failed++;
      this.#row(this.#bad("⊘"), `Blocked: ${what()}`, right);
      this.#line(`    ${paint(this.io.color, "dim", output.replace(/^Error:\s*/, "").split("\n")[0]!.slice(0, 110))}`);
    } else if (e.outcome === "timeout") { this.#counts.timeout++; this.#group.timeout++; this.#count(e.name); this.#row(this.#warn("⏱"), `${what()}`, `timed out${SEP}${right}`, notes); }
    else if (e.outcome === "stopped") { this.#row(this.#warn("■"), paint(this.io.color, "dim", `Stopped: ${what()}`), right, notes); }
    else if (e.outcome === "skipped") { this.#row(paint(this.io.color, "dim", "»"), paint(this.io.color, "dim", `Skipped: ${what()}`), ""); }
    else if (e.outcome === "redirected") { this.#row(paint(this.io.color, "dim", "↪"), paint(this.io.color, "dim", `Redirected, not run: ${what()}`), ""); }
    else if (e.outcome === "background") { this.#counts.background++; this.#group.background++; this.#count(e.name); this.#row(paint(this.io.color, "cyan", "◉"), what(), "running in the background", notes); }
    else {
      this.#count(e.name);
      const bad = e.status === "error" || e.screen?.verdict === "refused" || failed(output) || (e.code !== undefined && e.code !== null && e.code !== 0) || (bash ? bash.exitCode !== undefined && bash.exitCode !== 0 : false);
      const refusal = e.screen ? refusalWords(e.screen) : undefined;
      if (bad && refusal) {
        this.#counts.failed++; this.#group.failed++;
        this.#row(this.#bad("✗"), refusal.title, right, notes);
        this.#line(`    ${paint(this.io.color, "faint", "⎿")} ${paint(this.io.color, "dim", refusal.said)}`);
      } else if (bad) {
        this.#counts.failed++; this.#group.failed++;
        const code = e.code !== undefined && e.code !== null && e.code !== 0 ? `exit ${e.code}  ` : bash?.exitCode ? `exit ${bash.exitCode}  ` : "";
        this.#row(this.#bad("✗"), describeFailure(e.name, input, this.opts.cwd()), `${code}${right}`.trim(), notes);
        const said = (bash ? bash.lines : output.replace(/^Error:\s*/, "").split("\n")).map((l) => l.trim()).filter(Boolean).slice(-3);
        if (said.length) { this.#line(`    ${paint(this.io.color, "dim", "What it said")}`); for (const l of said) this.#line(`    ${paint(this.io.color, "dim", l.length > 100 ? `${l.slice(0, 99)}…` : l)}`); }
        if (bash) for (const n of bash.notes) this.#line(`    ${paint(this.io.color, "faint", n)}`);
      } else {
        const tail = stepTail(e.name, input, output);
        this.#row(this.#ok("✓"), `${what()}${tail ? `  ${paint(this.io.color, "dim", tail)}` : ""}`, right, notes);
        // What a command printed: the first lines, and how many more there are; then navvied's own quiet notes, apart from that output.
        if (bash && e.outcome !== "background") {
          const said = bash.lines.map((l) => l.trimEnd()).filter((l) => l.trim());
          for (const l of said.slice(0, PREVIEW_LINES)) this.#line(`    ${paint(this.io.color, "faint", "⎿")} ${paint(this.io.color, "dim", l.length > this.#width() - 10 ? `${l.slice(0, this.#width() - 11)}…` : l)}`);
          if (said.length > PREVIEW_LINES) this.#line(`      ${paint(this.io.color, "faint", `… ${said.length - PREVIEW_LINES} more line${said.length - PREVIEW_LINES > 1 ? "s" : ""}`)}`);
          for (const n of bash.notes) this.#line(`    ${paint(this.io.color, "faint", n)}`);
        }
        if (e.name === "Edit") this.#diff(input as Record<string, unknown>, output);
        const saved = savedFile(output);
        if (saved) {
          this.files.add(saved);
          for (const l of [saved.path, saved.size]) this.#line(`    ${paint(this.io.color, "faint", "⎿")} ${paint(this.io.color, "dim", l)}`);
        }
      }
    }
    this.#endStep(attention);
    this.#stepsDone++;
    const rec = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : undefined;
    const logInput = rec ? String(rec.command ?? (typeof rec.file_path === "string" ? shortPath(rec.file_path, this.opts.cwd()) : undefined) ?? rec.url ?? rec.pattern ?? JSON.stringify(rec)) : "";
    this.#log.push({ title: step.done, mark: e.outcome === "denied" ? "−" : e.outcome === "blocked" ? "⊘" : e.outcome === "timeout" ? "⏱" : e.outcome === "stopped" ? "■" : e.outcome === "skipped" ? "»" : e.outcome === "redirected" ? "↪" : e.outcome === "background" ? "◉" : (e.status === "error" || (e.code !== undefined && e.code !== null && e.code !== 0)) ? "✗" : "✓", ...(e.ms !== undefined ? { ms: e.ms } : {}), input: logInput, output: cleanOutput, ...(bash?.notes.length ? { notes: bash.notes } : {}) });
    this.#label = "";
    this.#renderLive();
  }

  #diff(input: Record<string, unknown>, output: string): void {
    const before = typeof input.old_string === "string" ? input.old_string : "", after = typeof input.new_string === "string" ? input.new_string : "";
    const rows = diffRows(before, after, startLine(output));
    if (!rows.length) return;
    this.#line(`    ${paint(this.io.color, "dim", shortPath(typeof input.file_path === "string" ? input.file_path : "", this.opts.cwd()))}`);
    for (const row of diffLines(rows, this.io.color, Math.max(20, this.#width() - 2))) this.#line(row);
  }

  #job(e: Extract<EngineEvent, { ev: "job" }>): void {
    if (e.status === "running") return;
    this.#settle();
    // A job that ends after the turn is over has no block to join: it is a line of its own.
    const during = this.#turnStart !== undefined;
    if (during) this.#stepStart();
    const put = (text: string): void => { if (during) this.#line(text); else this.#emit(text); };
    if (e.status === "done") put(`  ${this.#ok("✓")} ${e.title}  ${paint(this.io.color, "dim", "finished in the background")}`);
    else if (e.status === "stopped") put(`  ${paint(this.io.color, "dim", `■ ${e.title} was stopped`)}`);
    else put(`  ${this.#bad("✗")} ${e.title}  ${paint(this.io.color, "dim", `stopped working${e.code !== undefined ? `, exit ${e.code}` : ""}`)}`);
    if (during) this.#endStep(e.status !== "done");
  }

  /** "Ran 3 commands, read 1 file, 1 failed", as one plain sentence. */
  #summary(): string {
    const c = this.#counts;
    const parts: string[] = [];
    if (c.commands) parts.push(`${parts.length ? "ran" : "Ran"} ${c.commands} command${c.commands > 1 ? "s" : ""}`);
    if (c.reads) parts.push(`${parts.length ? "read" : "Read"} ${c.reads} file${c.reads > 1 ? "s" : ""}`);
    if (c.edits) parts.push(`${parts.length ? "changed" : "Changed"} ${c.edits} file${c.edits > 1 ? "s" : ""}`);
    if (c.failed) parts.push(`${c.failed} failed`);
    if (c.timeout) parts.push(`${c.timeout} timed out`);
    if (c.denied) parts.push(`${c.denied} declined`);
    if (c.background) parts.push(`${c.background} in the background`);
    return parts.join(", ");
  }

  #done(stop: string): void {
    this.#settle();
    this.#halt();
    const ms = this.#turnStart === undefined ? 0 : this.#now() - this.#turnStart;
    const seconds = Math.round(ms / 1000);
    this.#turnStart = undefined;
    this.#running.clear();
    this.#waiting.clear();
    this.#label = "";
    this.io.live?.(this.#queueLines());
    this.#closeWork();
    const hadWork = this.#summary() !== "";
    this.#counts = { commands: 0, reads: 0, edits: 0, failed: 0, denied: 0, timeout: 0, background: 0 };
    this.#stepsDone = 0;
    this.#started = false;
    this.#plan = [];
    if (stop === "cancelled") this.#line(`  ${this.#warn("■")} ${paint(this.io.color, "bold", "Stopped")}  ${paint(this.io.color, "dim", "You pressed Esc. Nothing was undone: /checkpoints lists what changed.")}`);
    else if (!hadWork && seconds >= 1) this.#line(`  ${paint(this.io.color, "faint", `${seconds} s`)}`);
    this.#markShown = false;
    this.#last = "none";
  }

  #queueLines(): string[] {
    if (!this.#queue.length) return [];
    const shown = this.#queue.slice(0, MAX_QUEUE_SHOWN).map((q) => `  ${paint(this.io.color, "dim", "Next, after this step:")} ${q.text.replace(/\s+/g, " ").slice(0, 80)}`);
    const more = this.#queue.length - shown.length;
    return ["", ...shown, ...(more > 0 ? [`  ${paint(this.io.color, "dim", `and ${more} more`)}`] : [])];
  }

  #renderLive(): void {
    if (!this.io.live) return;
    if (this.#turnStart === undefined) { this.io.live(this.#queueLines()); return; }
    const lines: string[] = [];
    // The steps of the block, one line each, changing in place while it works; folded away when it is done.
    if (this.#inWork && this.#collapse && this.#rows.length) {
      const shown = this.#rows.slice(-MAX_GROUP_SHOWN);
      lines.push(`  ${paint(this.io.color, "yellow", "⚙")} ${paint(this.io.color, "bold", "Work")}  ${paint(this.io.color, "dim", `${this.#rows.length} step${this.#rows.length > 1 ? "s" : ""} so far`)}`);
      if (this.#rows.length > shown.length) lines.push(`  ${paint(this.io.color, "faint", "│")} ${paint(this.io.color, "faint", `… ${this.#rows.length - shown.length} earlier`)}`);
      for (const r of shown) lines.push(`  ${paint(this.io.color, "faint", "│")} ${r.lines[0]!.slice(2)}`);
    }
    if (this.#partial) lines.push(`  ${this.#partial}`);
    else {
      const seconds = Math.round((this.#now() - this.#turnStart) / 1000);
      const label = this.#label || (this.#started ? "Thinking" : "Starting");
      lines.push(`  ${this.#warn(FRAMES[this.#frame % FRAMES.length]!)} ${paint(this.io.color, "bold", label)}${paint(this.io.color, "dim", "…")}${this.#stepsDone || seconds >= 1 ? `  ${paint(this.io.color, "dim", [this.#stepsDone ? `${this.#stepsDone} step${this.#stepsDone > 1 ? "s" : ""} done` : "", seconds >= 1 ? `${seconds} s` : ""].filter(Boolean).join(SEP))}` : ""}`);
      // What the running command is printing, as it prints.
      const current = [...this.#running.values()].find((r) => r.out.length);
      if (current) for (const row of current.out) lines.push(`    ${paint(this.io.color, "faint", "│")} ${paint(this.io.color, "dim", row.length > this.#width() - 10 ? `${row.slice(0, this.#width() - 11)}…` : row)}`);
      // The steps that wait their turn.
      const next = [...this.#waiting.values()];
      for (const w of next.slice(0, MAX_QUEUE_SHOWN)) lines.push(`  ${paint(this.io.color, "faint", "○")} ${paint(this.io.color, "dim", `Next: ${describeStep(w.name, w.input, this.opts.cwd()).running.replace(/^Running /, "")}`)}`);
      if (next.length > MAX_QUEUE_SHOWN) lines.push(`    ${paint(this.io.color, "faint", `and ${next.length - MAX_QUEUE_SHOWN} more step${next.length - MAX_QUEUE_SHOWN > 1 ? "s" : ""}`)}`);
      // The agent's task list, ticked off as it goes.
      for (const p of this.#plan.slice(0, MAX_PLAN_SHOWN)) lines.push(`  ${p.status === "completed" ? this.#ok("☑") : p.status === "in_progress" ? this.#warn("◐") : paint(this.io.color, "faint", "☐")} ${p.status === "completed" ? paint(this.io.color, "faint", p.title) : p.status === "in_progress" ? paint(this.io.color, "bold", p.title) : p.title}`);
      if (this.#plan.length > MAX_PLAN_SHOWN) lines.push(`    ${paint(this.io.color, "faint", `and ${this.#plan.length - MAX_PLAN_SHOWN} more tasks`)}`);
    }
    this.io.live([...lines, ...this.#queueLines()]);
  }
}
