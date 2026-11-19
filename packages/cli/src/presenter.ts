/**
 * Shows the conversation the way a person reads it: their own message in a block, what the agent does as short steps in plain
 * words, changes as tinted lines, the answer as formatted text, and while it works a live line saying what it is doing.
 * It replaces the plain stream of the renderer in the interactive app; the renderer still serves `run` and piped output.
 */
import type { EngineEvent } from "@navvied/protocol";
import type { IO } from "./io.ts";
import { Markdown } from "./markdown.ts";
import { paint, type Renderer } from "./render.ts";
import { describeFailure, describeStep, diffRows, failed, shortPath, startLine, stepTail, type Step } from "./steps.ts";
import { bgRgb, currentTheme, fgRgb, surfaces } from "./theme.ts";
import { diffLines } from "./diff-view.ts";

const RESET = "\u001b[0m";
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const TICK_MS = 120;
const MAX_QUEUE_SHOWN = 3;
const PREVIEW_LINES = 2;
const MAX_GROUP_SHOWN = 8;
/** 950 → "950", 1234 → "1.2k", 15200 → "15k". */
export const tokenCount = (n: number): string => (n < 1000 ? String(n) : n < 10_000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n / 1000)}k`);
const MAX_PLAN_SHOWN = 8;

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
  /** Tokens the model has written in this turn, when the engine says. */
  #turnOut = 0;
  #turnStart: number | undefined;
  #markShown = false;
  #thoughtStart: number | undefined;
  #label = "";
  #frame = 0;
  #stopTimer: (() => void) | undefined;
  #lastTool: { name: string; input: unknown } | undefined;
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
  #log: { title: string; mark: string; ms?: number; input: string; output: string }[] = [];
  /** What was shown last, so a step and a paragraph never touch each other. */
  #last: "none" | "step" | "text" = "none";

  constructor(private readonly io: IO, private readonly fallback: Renderer, private readonly opts: PresenterOptions) {
    this.#markdown = new Markdown(io.color, () => this.#width());
  }

  get usage(): { ctx: number; win: number } | undefined { return this.#usage ?? this.fallback.usage; }

  #lastOutput: { title: string; text: string } | undefined;

  /** Everything the last step that printed anything said, for `/output`. */
  /** Every step of this turn, for `/steps`. */
  get steps(): readonly { title: string; mark: string; ms?: number; input: string; output: string }[] { return this.#log; }

  get lastOutput(): { title: string; text: string } | undefined { return this.#lastOutput; }

  /** The step the engine is asking about, so the question can say what it is for. */
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
      case "approval": this.#settle(); return;
      case "phase": this.#label = e.name === "compacting" ? "Compacting context" : ""; this.#renderLive(); return;
      case "job": return this.#job(e);
      case "plan": this.#plan = e.entries.map((p) => ({ title: p.title, status: p.status })); this.#renderLive(); return;
      case "usage": this.#usage = { ctx: e.ctx, win: e.win }; if (e.turn) this.#turnOut = e.turn.out; this.fallback.handle(e); return;
      case "notice": this.#settle(); this.#closeWork(); this.#line(`  ${this.#warn("!")} ${e.msg}`); return;
      case "error": this.#settle(); this.#closeWork(); this.#line(`  ${this.#bad("✗")} ${paint(this.io.color, "bold", e.msg)}`); return;
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
    this.#block(this.opts.display?.(e.qid) ?? e.text);
    this.#renderLive();
  }

  /**
   * The person's message as a band: full width with an even margin on both sides, tinted, with a line of the accent colour above and
   * below, the word You in the accent colour, and the words under it with the same space on the left and the right.
   */
  #block(text: string): void {
    const total = this.#width();
    const wide = Math.max(24, total - 4);
    const inner = wide - 4;
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
    const t = currentTheme();
    const bg = this.io.color ? bgRgb(surfaces(t).you, t.truecolor) : "";
    // Colours inside a row end with a full reset, which would end the tint too: it is put back after each of them.
    const keep = (content: string): string => (bg ? content.split(RESET).join(`${RESET}${bg}`) : content);
    const row = (content: string): string => `  ${bg}${keep(content)}${" ".repeat(Math.max(0, wide - plain(content)))}${this.io.color ? RESET : ""}`;
    const rule = paint(this.io.color, "cyan", "─".repeat(wide));
    this.#write("\n");
    this.#line(`  ${bg}${keep(rule)}${this.io.color ? RESET : ""}`);
    this.#line(row(`  ${paint(this.io.color, "cyan", paint(this.io.color, "bold", "You"))}`));
    for (const r of shown) this.#line(row(`  ${r}`));
    this.#line(`  ${bg}${keep(rule)}${this.io.color ? RESET : ""}`);
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

  /** What a block of steps came to: "Ran 5 commands, read 1 file · 1 failed". */
  #groupSummary(): string {
    const g = this.#group;
    const parts: string[] = [];
    if (g.commands) parts.push(`${parts.length ? "ran" : "Ran"} ${g.commands} command${g.commands > 1 ? "s" : ""}`);
    if (g.reads) parts.push(`${parts.length ? "read" : "Read"} ${g.reads} file${g.reads > 1 ? "s" : ""}`);
    if (g.edits) parts.push(`${parts.length ? "changed" : "Changed"} ${g.edits} file${g.edits > 1 ? "s" : ""}`);
    const trouble = [g.failed ? `${g.failed} failed` : "", g.timeout ? `${g.timeout} timed out` : "", g.denied ? `${g.denied} declined` : "", g.background ? `${g.background} in the background` : ""].filter(Boolean);
    return [parts.join(", "), ...trouble].filter(Boolean).join("  ·  ") || `${g.steps} step${g.steps === 1 ? "" : "s"}`;
  }

  /** `⚙ Work  summary · time · note` on one line: when it would not fit, the last parts of the summary give way first. */
  #header(summary: string, time: string, note: string): string {
    const room = this.#width() - 2 - "⚙ Work  ".length;
    const items = summary.split("  ·  ");
    const build = (n: number): string => [...items.slice(0, n), time, ...(note ? [note] : [])].join("  ·  ");
    let n = items.length;
    while (n > 1 && build(n).length > room) n--;
    let text = build(n);
    if (text.length > room) {
      // Even the first part alone is too long: it is cut, and the time and the note stay.
      const tail = [time, ...(note ? [note] : [])].join("  ·  ");
      const first = items[0]!;
      const space = Math.max(8, room - tail.length - 5);
      text = `${first.length > space ? `${first.slice(0, space - 1)}…` : first}  ·  ${tail}`;
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
      this.#emit(this.#header(this.#groupSummary(), `${time}${this.#turnOut ? `  ·  ↓ ${tokenCount(this.#turnOut)} tokens` : ""}`, hidden ? `${hidden} folded: Ctrl+O` : "Ctrl+O for details"));
      this.#inWork = true;
      for (const row of this.#rows) {
        if (row.keep) for (const l of row.lines) this.#emit(l);
        else if (!this.#fold) this.#emit(row.lines[0]!);
      }
      this.#inWork = false;
    } else {
      this.#inWork = false;
      this.#emit(`  ${paint(this.io.color, "faint", `└ ${this.#groupSummary()}  ·  ${time}`)}`);
    }
    this.#rows = [];
    this.#emit("");
    this.#last = "step";
  }

  #ensureMark(): void {
    this.#closeWork();
    if (this.#markShown) return;
    this.#markShown = true;
    this.#line(`  ${paint(this.io.color, "cyan", "⬢")} ${paint(this.io.color, "bold", "navvied")}  ${paint(this.io.color, "dim", "report")}`);
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
      if (e.input !== undefined && !known.step) { known.input = e.input; known.step = describeStep(e.name, e.input, this.opts.cwd()); }
      return;
    }
    this.#running.delete(e.id);
    const step = known.step ?? describeStep(e.name, known.input, this.opts.cwd());
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
    else if (name === "Edit" || name === "Write") { this.#counts.edits++; this.#group.edits++; }
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
        known.step = describeStep(e.name, e.input, this.opts.cwd());
        this.#lastTool = { name: e.name, input: e.input };
        this.#label = known.step.running;
        this.#renderLive();
      } else if (e.input !== undefined && known.step && JSON.stringify(e.input) !== JSON.stringify(known.input)) {
        // The person changed the command before allowing it.
        known.input = e.input;
        known.step = describeStep(e.name, e.input, this.opts.cwd());
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
    const step = known.step ?? describeStep(e.name, known.input ?? e.input, this.opts.cwd());
    const input = known.input ?? e.input;
    const output = e.output ?? "";
    const right = e.ms !== undefined ? took(e.ms) : "";
    if (output.trim()) this.#lastOutput = { title: step.done, text: output.replace(/\n?\[exit \d+\]\s*$/, "") };
    const notes = [...(e.truncated ? ["TRUNCATED"] : []), ...((known as Running & { edited?: boolean }).edited ? ["EDITED"] : [])];
    const what = (): string => step.done;
    // A step stays on the screen when something went wrong or when it changed a file: those are what a person needs to see.
    const attention = (e.outcome !== undefined && e.outcome !== "background" && e.outcome !== "skipped" && e.outcome !== "redirected") || e.status === "error" || (e.code !== undefined && e.code !== null && e.code !== 0) || failed(e.output ?? "") || e.name === "Edit" || e.name === "Write";
    if (e.outcome === "denied") { this.#counts.denied++; this.#group.denied++; this.#row(paint(this.io.color, "dim", "−"), paint(this.io.color, "dim", `You said no: ${what()}`), right, notes); }
    else if (e.outcome === "blocked") {
      this.#counts.failed++; this.#group.failed++;
      this.#row(this.#bad("⊘"), `Blocked: ${what()}`, right);
      this.#line(`    ${paint(this.io.color, "dim", output.replace(/^Error:\s*/, "").split("\n")[0]!.slice(0, 110))}`);
    } else if (e.outcome === "timeout") { this.#counts.timeout++; this.#group.timeout++; this.#count(e.name); this.#row(this.#warn("⏱"), `${what()}`, `timed out · ${right}`, notes); }
    else if (e.outcome === "stopped") { this.#row(this.#warn("■"), paint(this.io.color, "dim", `Stopped: ${what()}`), right, notes); }
    else if (e.outcome === "skipped") { this.#row(paint(this.io.color, "dim", "»"), paint(this.io.color, "dim", `Skipped: ${what()}`), ""); }
    else if (e.outcome === "redirected") { this.#row(paint(this.io.color, "dim", "↪"), paint(this.io.color, "dim", `Redirected, not run: ${what()}`), ""); }
    else if (e.outcome === "background") { this.#counts.background++; this.#group.background++; this.#count(e.name); this.#row(paint(this.io.color, "cyan", "◉"), what(), "running in the background", notes); }
    else {
      this.#count(e.name);
      const bad = e.status === "error" || failed(output) || (e.code !== undefined && e.code !== null && e.code !== 0) || /\[exit [1-9]\d*\]\s*$/.test(output);
      if (bad) {
        this.#counts.failed++; this.#group.failed++;
        const code = e.code !== undefined && e.code !== null && e.code !== 0 ? `exit ${e.code}  ` : "";
        this.#row(this.#bad("✗"), describeFailure(e.name, input, this.opts.cwd()), `${code}${right}`.trim(), notes);
        const said = output.replace(/^Error:\s*/, "").split("\n").map((l) => l.trim()).filter((l) => l && !/^\[exit/.test(l)).slice(-3);
        if (said.length) { this.#line(`    ${paint(this.io.color, "dim", "What it said")}`); for (const l of said) this.#line(`    ${paint(this.io.color, "dim", l.length > 100 ? `${l.slice(0, 99)}…` : l)}`); }
      } else {
        const tail = stepTail(e.name, input, output);
        this.#row(this.#ok("✓"), `${what()}${tail ? `  ${paint(this.io.color, "dim", tail)}` : ""}`, right, notes);
        // What a command printed: the first lines, and how many more there are.
        if (e.name === "Bash" && e.outcome !== "background") {
          const said = output.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim() && !/^\[exit \d+\]$/.test(l.trim()));
          for (const l of said.slice(0, PREVIEW_LINES)) this.#line(`    ${paint(this.io.color, "faint", "⎿")} ${paint(this.io.color, "dim", l.length > this.#width() - 10 ? `${l.slice(0, this.#width() - 11)}…` : l)}`);
          if (said.length > PREVIEW_LINES) this.#line(`      ${paint(this.io.color, "faint", `… ${said.length - PREVIEW_LINES} more line${said.length - PREVIEW_LINES > 1 ? "s" : ""}`)}`);
        }
        if (e.name === "Edit") this.#diff(input as Record<string, unknown>, output);
      }
    }
    this.#endStep(attention);
    this.#stepsDone++;
    this.#log.push({ title: step.done, mark: e.outcome === "denied" ? "−" : e.outcome === "blocked" ? "⊘" : e.outcome === "timeout" ? "⏱" : e.outcome === "stopped" ? "■" : e.outcome === "skipped" ? "»" : e.outcome === "redirected" ? "↪" : e.outcome === "background" ? "◉" : (e.status === "error" || (e.code !== undefined && e.code !== null && e.code !== 0)) ? "✗" : "✓", ...(e.ms !== undefined ? { ms: e.ms } : {}), input: typeof input === "object" && input !== null ? String((input as Record<string, unknown>).command ?? (input as Record<string, unknown>).file_path ?? (input as Record<string, unknown>).url ?? (input as Record<string, unknown>).pattern ?? JSON.stringify(input)) : "", output: output.replace(/\n?\[exit \d+\]\s*$/, "") });
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

  /** "Ran 3 commands, read 1 file", and what did not go well. */
  #summary(): string {
    const c = this.#counts;
    const parts: string[] = [];
    if (c.commands) parts.push(`${parts.length ? "ran" : "Ran"} ${c.commands} command${c.commands > 1 ? "s" : ""}`);
    if (c.reads) parts.push(`${parts.length ? "read" : "Read"} ${c.reads} file${c.reads > 1 ? "s" : ""}`);
    if (c.edits) parts.push(`${parts.length ? "changed" : "Changed"} ${c.edits} file${c.edits > 1 ? "s" : ""}`);
    const trouble = [c.failed ? `${c.failed} failed` : "", c.timeout ? `${c.timeout} timed out` : "", c.denied ? `${c.denied} declined` : "", c.background ? `${c.background} in the background` : ""].filter(Boolean);
    return [parts.join(", "), ...trouble].filter(Boolean).join("  ·  ");
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
    this.#turnOut = 0;
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
      lines.push(`  ${this.#warn(FRAMES[this.#frame % FRAMES.length]!)} ${paint(this.io.color, "bold", label)}${paint(this.io.color, "dim", "…")}${this.#stepsDone || seconds >= 1 ? `  ${paint(this.io.color, "dim", [this.#stepsDone ? `${this.#stepsDone} step${this.#stepsDone > 1 ? "s" : ""} done` : "", seconds >= 1 ? `${seconds} s` : "", this.#turnOut ? `↓ ${tokenCount(this.#turnOut)} tokens` : ""].filter(Boolean).join("  ·  "))}` : ""}`);
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
