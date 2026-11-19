import type { EngineEvent, PlanEntry } from "@navvied/protocol";

type Json = Record<string, unknown>;

const obj = (v: unknown): Json => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : {});
const text = (v: unknown): string => (typeof v === "string" ? v : "");
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const MAX_OUTPUT = 4000;

/** What a person should read when a turn fails: the sign-in problem in plain words, anything else as the program said it. */
export function friendlyFailure(message: string): string {
  if (/401|unauthori[sz]ed|missing bearer|not logged in|sign in/i.test(message)) return "Codex is not signed in. Use /model to sign in again.";
  const one = message.replace(/\s+/g, " ").trim();
  return one.length > 300 ? `${one.slice(0, 299)}…` : one;
}

const plan = (items: unknown): PlanEntry[] =>
  arr(items).map((i): PlanEntry => ({ title: text(obj(i).text), status: obj(i).completed === true ? "completed" : "pending" })).filter((e) => e.title);

/**
 * Turns the JSON lines of `codex exec --json` into protocol events. Pure apart from its own bookkeeping: a line goes in,
 * events come out. Codex reports a message when it is complete (not word by word), and keeps going after a transient
 * "reconnecting" error, so only `turn.failed` ends a turn badly.
 */
export class CodexTranslator {
  threadId = "";
  #started = new Set<string>();
  #running = new Map<string, string>();

  constructor(readonly window: number) {}

  feed(raw: unknown): EngineEvent[] {
    const o = obj(raw);
    switch (text(o.type)) {
      case "thread.started": {
        this.threadId = text(o.thread_id);
        return this.threadId ? [{ ev: "session", id: this.threadId }] : [];
      }
      case "item.started": return this.#started_(obj(o.item));
      case "item.updated": return obj(o.item).type === "todo_list" ? [{ ev: "plan", entries: plan(obj(o.item).items) }] : [];
      case "item.completed": return this.#completed(obj(o.item));
      case "turn.completed": {
        const u = obj(o.usage);
        const input = Number(u.input_tokens) || 0;
        return [{ ev: "usage", ctx: input, win: this.window, out: Number(u.output_tokens) || 0 }, { ev: "done", stop: "end_turn" }];
      }
      case "turn.failed": return [{ ev: "error", msg: friendlyFailure(text(obj(o.error).message) || "The turn failed.") }, { ev: "done", stop: "error" }];
      default: return [];
    }
  }

  #started_(item: Json): EngineEvent[] {
    const id = text(item.id);
    const kind = text(item.type);
    if (!id || this.#started.has(id)) return [];
    if (kind === "command_execution") {
      this.#started.add(id);
      this.#running.set(id, "Bash");
      return [{ ev: "tool", id, name: "Bash", status: "running", input: { command: text(item.command) } }];
    }
    if (kind === "mcp_tool_call") {
      this.#started.add(id);
      const name = `${text(item.server)}:${text(item.tool)}`.replace(/^:|:$/g, "") || "Tool";
      this.#running.set(id, name);
      return [{ ev: "tool", id, name, status: "running", input: item.arguments }];
    }
    if (kind === "web_search") {
      this.#started.add(id);
      this.#running.set(id, "WebSearch");
      return [{ ev: "tool", id, name: "WebSearch", status: "running", input: { query: text(item.query) } }];
    }
    return [];
  }

  #completed(item: Json): EngineEvent[] {
    const id = text(item.id);
    switch (text(item.type)) {
      case "agent_message": return text(item.text) ? [{ ev: "text", text: `${text(item.text)}\n` }] : [];
      case "reasoning": return text(item.text) ? [{ ev: "thought", text: text(item.text) }] : [];
      case "todo_list": return [{ ev: "plan", entries: plan(item.items) }];
      case "command_execution": {
        const code = item.exit_code;
        const failed = (typeof code === "number" && code !== 0) || text(item.status) === "failed";
        const output = text(item.aggregated_output).slice(-MAX_OUTPUT);
        const exit = typeof code === "number" ? `[exit ${code}]` : "";
        return [...this.#opened(id, "Bash", { command: text(item.command) }), { ev: "tool", id, name: "Bash", status: failed ? "error" : "done", output: [output, exit].filter(Boolean).join("\n") }];
      }
      case "file_change": {
        const changes = arr(item.changes).map(obj).map((c) => ({ path: text(c.path), kind: text(c.kind) }));
        const done = text(item.status) !== "failed";
        return [{ ev: "tool", id, name: "Edit", status: done ? "done" : "error", input: { paths: changes.map((c) => c.path) }, output: changes.map((c) => `${c.kind || "changed"} ${c.path}`).join("\n") }];
      }
      case "mcp_tool_call": {
        const name = this.#running.get(id) ?? (`${text(item.server)}:${text(item.tool)}`.replace(/^:|:$/g, "") || "Tool");
        const failed = text(item.status) === "failed" || item.error !== undefined && item.error !== null;
        return [{ ev: "tool", id, name, status: failed ? "error" : "done", output: JSON.stringify(item.result ?? item.error ?? "").slice(0, MAX_OUTPUT) }];
      }
      case "web_search": return [...this.#opened(id, "WebSearch", { query: text(item.query) }), { ev: "tool", id, name: "WebSearch", status: "done", output: "" }];
      default: return [];
    }
  }

  /** A tool that finished without ever being seen starting still gets a row. */
  #opened(id: string, name: string, input: unknown): EngineEvent[] {
    if (this.#started.has(id)) return [];
    this.#started.add(id);
    return [{ ev: "tool", id, name, status: "running", input }];
  }
}
