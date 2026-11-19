/**
 * Translates the output of an external agent that streams JSON lines (partial text, tool calls, results) into navvied
 * protocol events. Pure apart from its own bookkeeping: a line goes in, events come out — so it is tested without a process.
 */
import type { EngineEvent } from "@navvied/protocol";

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const text = (v: unknown): string => (typeof v === "string" ? v : "");
const int = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : 0);

/** The tool the agent uses to hand in a finished plan (plan mode). Shown as text plus a proposal, never as a tool card. */
const PLAN_TOOL = "ExitPlanMode";
const TOO_LONG = /^prompt is too long/i;

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  return arr(content).map((c) => (typeof c === "string" ? c : text(obj(c).text))).join("\n");
}

export interface TranslatorOptions {
  window: number;
  now?: () => number;
  onTaken?: (uuid: string) => void;
}

export class Translator {
  #toolNames = new Map<string, string>();
  #hidden = new Set<string>();
  #live = new Map<number, { id: string; name: string; bytes: number; at: number }>();
  #streamedText = false;
  #tooLong = false;
  #sessionId: string | undefined;
  /** user-message uuid → the client's qid, for `taken` */
  #uuids = new Map<string, string>();
  /** Set by the engine when the user cancelled: the turn's result then means "cancelled", not an error. */
  interrupting = false;

  constructor(private readonly opts: TranslatorOptions) {}

  get sessionId(): string | undefined { return this.#sessionId; }

  expect(uuid: string, qid: string | undefined): void { if (qid) this.#uuids.set(uuid, qid); }

  feed(raw: unknown): EngineEvent[] {
    const o = obj(raw);
    const type = text(o.type);
    const parent = text(o.parent_tool_use_id);
    if (parent) return this.#subagent(type, o, parent);
    switch (type) {
      case "system": return this.#system(o);
      case "stream_event": return this.#stream(obj(o.event));
      case "assistant": return this.#assistant(obj(o.message));
      case "user": return this.#user(o);
      case "result": return this.#result(o);
      default: return [];
    }
  }

  #system(o: Json): EngineEvent[] {
    switch (text(o.subtype)) {
      case "init": {
        const id = text(o.session_id);
        if (id && id !== this.#sessionId) { this.#sessionId = id; return [{ ev: "session", id }]; }
        return [];
      }
      case "status": return [{ ev: "phase", name: text(o.status) === "compacting" ? "compacting" : "" }];
      case "compact_boundary": return [{ ev: "phase", name: "" }];
      default: return [];
    }
  }

  #stream(e: Json): EngineEvent[] {
    const kind = text(e.type);
    if (kind === "content_block_start") {
      const block = obj(e.content_block);
      if (text(block.type) !== "tool_use") return [];
      const id = text(block.id), name = text(block.name);
      this.#toolNames.set(id, name);
      if (name === PLAN_TOOL) { this.#hidden.add(id); return []; }
      this.#live.set(int(e.index), { id, name, bytes: 0, at: 0 });
      return [{ ev: "tool", id, name, status: "running", progress: 0 }]; // the card appears while a long input is still being written
    }
    if (kind !== "content_block_delta") return [];
    const d = obj(e.delta);
    switch (text(d.type)) {
      case "text_delta": if (!text(d.text)) return []; this.#streamedText = true; return [{ ev: "text", text: text(d.text) }];
      case "thinking_delta": return text(d.thinking) ? [{ ev: "thought", text: text(d.thinking) }] : [];
      case "input_json_delta": {
        const live = this.#live.get(int(e.index));
        if (!live) return [];
        live.bytes += text(d.partial_json).length;
        const now = (this.opts.now ?? Date.now)();
        if (now - live.at < 1000) return [];
        live.at = now;
        return [{ ev: "tool", id: live.id, name: live.name, status: "running", progress: live.bytes }];
      }
      default: return [];
    }
  }

  #assistant(m: Json): EngineEvent[] {
    const out: EngineEvent[] = [];
    const u = obj(m.usage);
    const ctx = int(u.input_tokens) + int(u.cache_read_input_tokens) + int(u.cache_creation_input_tokens);
    if (ctx > 0) out.push({ ev: "usage", ctx, win: this.opts.window, out: int(u.output_tokens) });

    for (const raw of arr(m.content)) {
      const c = obj(raw);
      switch (text(c.type)) {
        case "tool_use": {
          const id = text(c.id), name = text(c.name);
          this.#toolNames.set(id, name);
          if (name === PLAN_TOOL) {
            this.#hidden.add(id);
            const plan = text(obj(c.input).plan).trim();
            if (plan) out.push({ ev: "text", text: `\n\n${plan}\n` }, { ev: "plan_proposal", id });
          } else out.push({ ev: "tool", id, name, status: "running", input: c.input });
          break;
        }
        case "text": {
          const t = text(c.text);
          if (TOO_LONG.test(t.trim())) this.#tooLong = true; // reported at the end of the turn, not shown as an answer
          else if (t && !this.#streamedText) out.push({ ev: "text", text: t });
          break;
        }
        case "thinking": if (text(c.thinking) && !this.#streamedText) out.push({ ev: "thought", text: text(c.thinking) }); break;
      }
    }
    return out;
  }

  #user(o: Json): EngineEvent[] {
    if (o.isReplay === true) {
      this.opts.onTaken?.(text(o.uuid));
      const qid = this.#uuids.get(text(o.uuid));
      return qid ? [{ ev: "taken", qid }] : [];
    }
    const out: EngineEvent[] = [];
    for (const raw of arr(obj(o.message).content)) {
      const c = obj(raw);
      if (text(c.type) !== "tool_result") continue;
      const id = text(c.tool_use_id);
      if (this.#hidden.has(id)) continue; // the plan hand-in is not a step
      out.push({ ev: "tool", id, name: this.#toolNames.get(id) ?? "tool", status: c.is_error === true ? "error" : "done", output: resultText(c.content) });
    }
    return out;
  }

  /** A sub-agent's steps are shown as children of the call that started it; its text never joins the main answer. */
  #subagent(type: string, o: Json, parent: string): EngineEvent[] {
    const out: EngineEvent[] = [];
    if (type === "assistant") {
      for (const raw of arr(obj(o.message).content)) {
        const c = obj(raw);
        if (text(c.type) !== "tool_use") continue;
        this.#toolNames.set(text(c.id), text(c.name));
        out.push({ ev: "tool", id: text(c.id), name: text(c.name), status: "running", input: c.input, parent });
      }
    } else if (type === "user") {
      for (const raw of arr(obj(o.message).content)) {
        const c = obj(raw);
        if (text(c.type) !== "tool_result") continue;
        const id = text(c.tool_use_id);
        out.push({ ev: "tool", id, name: this.#toolNames.get(id) ?? "tool", status: c.is_error === true ? "error" : "done", output: resultText(c.content), parent });
      }
    }
    return out;
  }

  #result(o: Json): EngineEvent[] {
    this.#streamedText = false;
    this.#live.clear();
    const cancelled = this.interrupting;
    this.interrupting = false;
    const subtype = text(o.subtype);
    if (cancelled) return [{ ev: "done", stop: "cancelled" }];
    if (this.#tooLong) {
      this.#tooLong = false;
      return [{ ev: "error", msg: "The conversation no longer fits the model's context window. Start a new conversation." }, { ev: "done", stop: "error" }];
    }
    if ((subtype && subtype !== "success") || o.is_error === true) {
      const detail = text(o.result).trim();
      return [{ ev: "error", msg: detail ? `The agent stopped: ${detail.slice(0, 300)}` : "The agent hit a limit or an error. Try again shortly." }, { ev: "done", stop: "error" }];
    }
    return [{ ev: "done", stop: "end_turn" }];
  }
}
