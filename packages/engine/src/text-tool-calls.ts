import { parseLenient } from "./lenient-json.ts";
import type { ToolCall } from "./types.ts";

type Schema = { properties?: Record<string, { type?: string }> };

const MARKERS = ["<tool_call>", "<function=", "</tool_call>"];
const CLOSER = { tool_call: "</tool_call>", function: "</function>" } as const;

/** What a model's server did not turn into a call: it wrote the call out as text, so the text is turned into a call here. */
export class TextToolCalls {
  /** Everything that was not a call: what the person should read. */
  shown = "";
  readonly calls: ToolCall[] = [];
  #held = "";
  #block: keyof typeof CLOSER | undefined;
  #afterBlock = false;

  constructor(private readonly schemas: Record<string, Schema>, private readonly idPrefix: string) {}

  /** Takes the next piece of the reply and returns the part that is safe to show now. */
  push(piece: string): string {
    this.#held += piece;
    let out = "";
    for (;;) {
      if (this.#block) {
        const closer = CLOSER[this.#block];
        const at = this.#held.indexOf(closer);
        if (at < 0) break;
        const raw = this.#held.slice(0, at + closer.length);
        this.#held = this.#held.slice(at + closer.length);
        this.#block = undefined;
        this.#afterBlock = true;
        out += this.#take(raw);
        continue;
      }
      if (this.#afterBlock) {
        const rest = this.#held.trimStart();
        if (rest.startsWith("</tool_call>")) { this.#held = rest.slice("</tool_call>".length); continue; }
        if (!rest || "</tool_call>".startsWith(rest)) { this.#held = rest; break; }
        this.#held = rest;
        this.#afterBlock = false;
      }
      const found = MARKERS.map((m) => ({ m, at: this.#held.indexOf(m) })).filter((f) => f.at >= 0).sort((a, b) => a.at - b.at)[0];
      if (found) {
        out += this.#held.slice(0, found.at);
        this.#held = this.#held.slice(found.at + (found.m === "</tool_call>" ? found.m.length : 0));
        if (found.m !== "</tool_call>") this.#block = found.m === "<tool_call>" ? "tool_call" : "function";
        continue;
      }
      const keep = this.#partialMarker();
      out += this.#held.slice(0, this.#held.length - keep);
      this.#held = this.#held.slice(this.#held.length - keep);
      break;
    }
    this.shown += out;
    return out;
  }

  /** The reply is over: whatever is still held back was not a call after all. */
  finish(): string {
    const rest = this.#held;
    this.#held = "";
    this.#block = undefined;
    this.shown += rest;
    return rest;
  }

  #partialMarker(): number {
    let keep = 0;
    for (const m of MARKERS) for (let n = Math.min(m.length - 1, this.#held.length); n > keep; n--) if (m.startsWith(this.#held.slice(this.#held.length - n))) { keep = n; break; }
    return keep;
  }

  #take(raw: string): string {
    const call = this.#parse(raw);
    if (!call) return raw;
    this.calls.push({ id: `${this.idPrefix}${this.calls.length}`, ...call });
    return "";
  }

  #parse(raw: string): Pick<ToolCall, "name" | "arguments"> | undefined {
    const named = /<function=([^>\s]+)>([\s\S]*?)(?:<\/function>|$)/.exec(raw);
    if (named) {
      const name = named[1]!, schema = this.schemas[name];
      const args: Record<string, unknown> = {};
      for (const p of named[2]!.matchAll(/<parameter=([^>\s]+)>([\s\S]*?)<\/parameter>/g)) args[p[1]!] = coerce(p[2]!.replace(/^\n/, "").replace(/\n$/, ""), schema?.properties?.[p[1]!]?.type);
      return { name, arguments: JSON.stringify(args) };
    }
    const json = parseLenient(raw.replace(/<\/?tool_call>/g, ""));
    const name = json?.name;
    if (typeof name !== "string") return undefined;
    const args = json!.arguments ?? json!.parameters ?? {};
    return { name, arguments: typeof args === "string" ? args : JSON.stringify(args) };
  }
}

function coerce(value: string, type: string | undefined): unknown {
  if (type === undefined || type === "string") return value;
  try { return JSON.parse(value); } catch { return value; }
}
