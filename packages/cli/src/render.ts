/**
 * Readable terminal output for engine events. The answer goes to stdout (so it can be piped or redirected);
 * everything about the work itself — tool steps, plans, usage, errors — goes to stderr.
 */
import type { EngineEvent } from "@navvied/protocol";
import type { IO } from "./io.ts";
import { currentTheme, fg } from "./theme.ts";

const CODES = { bold: "1", red: "31", green: "32", yellow: "33" } as const;

/** `cyan` is the theme's accent, `dim` its secondary text and `faint` its rule colour (all from navvied.com); the rest are plain terminal colours. */
export const paint = (color: boolean, style: keyof typeof CODES | "cyan" | "dim" | "faint", text: string): string => {
  if (!color) return text;
  const t = currentTheme();
  const start = style === "cyan" ? fg(t.accent, t.truecolor) : style === "dim" ? fg(t.dim, t.truecolor) : style === "faint" ? fg(t.faint, t.truecolor) : `\u001b[${CODES[style]}m`;
  return `${start}${text}\u001b[0m`;
};

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const oneLine = (s: string, max = 100): string => { const t = s.replace(/\s+/g, " ").trim(); return t.length > max ? `${t.slice(0, max - 1)}…` : t; };

export function describeTool(name: string, input: unknown): string {
  const a = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  switch (name) {
    case "Bash": return `$ ${oneLine(str(a.command))}`;
    case "Read": case "Write": case "Edit": return str(a.file_path);
    case "Glob": case "Grep": return oneLine(str(a.pattern));
    case "WebFetch": return str(a.url);
    case "TodoWrite": return "task list";
    default: return "";
  }
}

export function ago(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  return s < 60 ? "just now" : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86_400 ? `${Math.floor(s / 3600)} h ago` : `${Math.floor(s / 86_400)} d ago`;
}

export interface RenderOptions {
  thinking: boolean;
  /** What to show at the start of the status line (the interactive session passes its model and mode). */
  status?: () => { model: string; mode: string };
  now?: () => number;
}

/** The one quiet line that says a call to the model is being made again. */
export const retryLine = (e: { reason: string; attempt: number; of: number; inSeconds: number }): string =>
  `${e.reason.charAt(0).toUpperCase()}${e.reason.slice(1)}. Trying again in ${e.inSeconds} s (try ${e.attempt} of ${e.of}).`;

export class Renderer {
  #atLineStart = true;
  #tools = new Map<string, { name: string; described: boolean }>();
  #lastUsage: { ctx: number; win: number } | undefined;
  #turnStart: number | undefined;

  constructor(private readonly io: IO, private readonly opts: RenderOptions) {}

  get usage(): { ctx: number; win: number } | undefined { return this.#lastUsage; }

  handle(e: EngineEvent): void {
    const { io } = this;
    const c = io.color;
    switch (e.ev) {
      case "taken": this.#turnStart ??= (this.opts.now ?? Date.now)(); return;
      case "text": io.stdout.write(e.text); this.#atLineStart = e.text.endsWith("\n"); return;
      case "thought": if (this.opts.thinking) io.stderr.write(paint(c, "dim", e.text)); return;
      case "tool": return this.#tool(e);
      case "plan":
        io.stderr.write(`${e.entries.map((p) => `  ${p.status === "completed" ? "[x]" : p.status === "in_progress" ? "[~]" : "[ ]"} ${p.title}`).join("\n")}\n`);
        return;
      case "approval": io.stderr.write(`${paint(c, "yellow", "? approval needed:")} ${e.title}\n`); return;
      case "plan_proposal": io.stderr.write(`\n${paint(c, "cyan", "Plan ready.")}\n`); return;
      case "phase": if (e.name === "compacting") io.stderr.write(paint(c, "dim", "compacting the conversation…\n")); return;
      case "usage": this.#lastUsage = { ctx: e.ctx, win: e.win }; return;
      case "retry": io.stderr.write(`${paint(c, "dim", retryLine(e))}\n`); return;
      case "notice": io.stderr.write(`${paint(c, "yellow", "note:")} ${e.msg}\n`); return;
      case "error": io.stderr.write(`${paint(c, "red", "error:")} ${e.msg}\n`); return;
      case "checkpoints":
        io.stderr.write(e.items.length ? e.items.map((cp, i) => `  ${i + 1}  ${cp.id}  ${ago(cp.at)}  ${oneLine(cp.label, 70)}  (${cp.repos.join(", ")})`).join("\n") + "\n" : "no checkpoints yet\n");
        return;
      case "restore": return this.#restore(e);
      case "done": this.#finish(e.stop); return;
      default: return;
    }
  }

  #tool(e: Extract<EngineEvent, { ev: "tool" }>): void {
    const c = this.io.color;
    const known = this.#tools.get(e.id) ?? { name: e.name, described: false };
    this.#tools.set(e.id, known);
    if (e.status === "running") {
      if (!known.described && e.input !== undefined) {
        known.described = true;
        this.#ensureLine();
        this.io.stderr.write(`${paint(c, "cyan", "●")} ${paint(c, "bold", e.name)} ${describeTool(e.name, e.input)}\n`);
      }
      return;
    }
    const first = oneLine((e.output ?? "").split("\n")[0] ?? "", 120);
    this.io.stderr.write(e.status === "error" ? `  ${paint(c, "red", "✗")} ${first}\n` : `  ${paint(c, "green", "✓")} ${paint(c, "dim", first)}\n`);
  }

  #restore(e: Extract<EngineEvent, { ev: "restore" }>): void {
    const verb = { revert: "revert", recreate: "bring back", remove: "delete" } as const;
    if (!e.changes.length) { this.io.stderr.write(e.preview ? "nothing to restore: the code already matches\n" : "nothing changed\n"); return; }
    const shown = e.changes.slice(0, 30).map((c) => `  ${e.preview ? verb[c.change] : c.change === "remove" ? "deleted" : c.change === "recreate" ? "brought back" : "reverted"}  ${c.path}`);
    this.io.stderr.write(`${shown.join("\n")}${e.changes.length > 30 ? `\n  … and ${e.changes.length - 30} more` : ""}\n`);
    if (!e.preview && e.undoId) this.io.stderr.write(`restored ${e.changes.length} file${e.changes.length === 1 ? "" : "s"}; undo with: restore ${e.undoId}\n`);
  }

  #finish(stop: string): void {
    this.#ensureLine();
    const u = this.#lastUsage;
    const c = this.io.color;
    const elapsed = this.#turnStart === undefined ? undefined : ((this.opts.now ?? Date.now)() - this.#turnStart) / 1000;
    this.#turnStart = undefined;
    const share = u ? u.ctx / Math.max(1, u.win) : 0;
    const used = u ? `Context ${Math.round(share * 100)}% (${u.ctx.toLocaleString("en-US")} of ${u.win.toLocaleString("en-US")} tokens)` : "";
    const took = elapsed === undefined ? "" : ` in ${elapsed.toFixed(1)} s`;
    const line = [`${stop === "cancelled" ? "Stopped" : "Done"}${took}`, share >= 0.85 ? paint(c, "red", used) : used].filter(Boolean).join("   ");
    if (line) this.io.stderr.write(`${paint(c, "dim", line)}\n`);
  }

  /** Text is on stdout and steps are on stderr: start steps on a fresh line. */
  #ensureLine(): void {
    if (!this.#atLineStart) { this.io.stdout.write("\n"); this.#atLineStart = true; }
  }
}
