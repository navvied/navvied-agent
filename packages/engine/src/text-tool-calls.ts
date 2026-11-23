import { parseLenient } from "./lenient-json.ts";
import type { ToolCall } from "./types.ts";

type Schema = { properties?: Record<string, { type?: string }> };

const MARKERS = ["<tool_call>", "<function=", "</tool_call>", "```"];
const CLOSER = { tool_call: "</tool_call>", function: "</function>", fence: "```" } as const;

/** What a model's server did not turn into a call: it wrote the call out as text, so the text is turned into a call here. */
export class TextToolCalls {
  /** Everything that was not a call: what the person should read. */
  shown = "";
  readonly calls: ToolCall[] = [];
  #held = "";
  #block: keyof typeof CLOSER | undefined;
  #afterBlock = false;
  /** The opening of a fenced block that may hold a call (its first line), kept to give the text back when it was not one. */
  #opening = "";
  /** Inside a fenced block that is plain text (code, an example): its closing fence is not the opening of another. */
  #plain = false;
  /** The reply began with `{`: it is held to the end, because a reply that is nothing but one JSON object may be a call written out bare. */
  #bare = false;
  #started = false;

  constructor(private readonly schemas: Record<string, Schema>, private readonly idPrefix: string) {}

  /** Takes the next piece of the reply and returns the part that is safe to show now. */
  push(piece: string): string {
    this.#held += piece;
    // The first word of a reply says whether it may be a call written bare, so nothing is shown before it is there.
    if (!this.#started) {
      if (!this.#held.trim()) return "";
      this.#started = true;
      this.#bare = this.#held.trimStart().startsWith("{");
    }
    if (this.#bare) return "";
    let out = "";
    for (;;) {
      if (this.#block) {
        const closer = CLOSER[this.#block];
        const at = this.#held.indexOf(closer);
        if (at < 0) break;
        const raw = this.#held.slice(0, at + closer.length);
        this.#held = this.#held.slice(at + closer.length);
        const fenced = this.#block === "fence";
        this.#block = undefined;
        if (fenced) { out += this.#takeFenced(raw); continue; }
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
      if (found?.m === "```") {
        out += this.#held.slice(0, found.at);
        this.#held = this.#held.slice(found.at);
        if (this.#plain) { this.#plain = false; out += "```"; this.#held = this.#held.slice(3); continue; }
        // A fence that opens with a `{` may hold a call written as JSON: it is held until it closes. Any other fence is text.
        const head = /^```([A-Za-z0-9_+-]*)[ \t]*\r?\n[ \t\r\n]*(\S)?/.exec(this.#held);
        if (!head || head[2] === undefined) { if (/^```[A-Za-z0-9_+-]*[ \t]*\r?\n?[ \t\r\n]*$/.test(this.#held)) break; }
        if (head?.[2] === "{") {
          const line = /^```[A-Za-z0-9_+-]*[ \t]*\r?\n/.exec(this.#held)![0];
          this.#opening = line;
          this.#held = this.#held.slice(line.length);
          this.#block = "fence";
          continue;
        }
        this.#plain = true;
        out += "```";
        this.#held = this.#held.slice(3);
        continue;
      }
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
    if (this.#bare) {
      const text = this.#held;
      this.#held = "";
      this.#bare = false;
      const taken = this.#takeBare(text);
      this.shown += taken;
      return taken;
    }
    const rest = (this.#block === "fence" ? this.#opening : "") + this.#held;
    this.#held = "";
    this.#opening = "";
    this.#plain = false;
    this.#block = undefined;
    this.shown += rest;
    return rest;
  }

  #partialMarker(): number {
    let keep = 0;
    for (const m of MARKERS) for (let n = Math.min(m.length - 1, this.#held.length); n > keep; n--) if (m.startsWith(this.#held.slice(this.#held.length - n))) { keep = n; break; }
    return keep;
  }

  /**
   * A reply that is only JSON objects, one or more with whitespace between, each naming a tool of this reply with its arguments, is a run of calls. A model that copies
   * the doubled braces of its own chat template (`{{"name": ...}}`) is understood too. Any other word, or an object that is no call, makes the whole reply text.
   */
  #takeBare(text: string): string {
    const found: Pick<ToolCall, "name" | "arguments">[] = [];
    for (let at = 0; at < text.length;) {
      if (/\s/.test(text[at]!)) { at++; continue; }
      const end = text[at] === "{" ? objectEnd(text, at) : -1;
      const call = end < 0 ? undefined : this.#asCall(text.slice(at, end + 1));
      if (!call) return text;
      found.push(call);
      at = end + 1;
    }
    for (const c of found) this.calls.push({ id: `${this.idPrefix}${this.calls.length}`, ...c });
    return "";
  }

  #asCall(candidate: string): Pick<ToolCall, "name" | "arguments"> | undefined {
    const doubled = candidate.startsWith("{{") && candidate.endsWith("}}");
    const json = parseLenient(doubled ? candidate.slice(1, -1) : candidate);
    const name = json?.name;
    const args = json?.arguments ?? json?.parameters;
    const only = json && Object.keys(json).every((k) => k === "name" || k === "arguments" || k === "parameters");
    if (typeof name === "string" && Object.hasOwn(this.schemas, name) && only && typeof args === "object" && args !== null && !Array.isArray(args)) return { name, arguments: JSON.stringify(args) };
    return undefined;
  }

  /** A fenced block that held JSON: a call when it is one of the tools this reply may use, with nothing else in it; else it is text again, as it was written. */
  #takeFenced(raw: string): string {
    const body = raw.slice(0, raw.length - 3);
    const json = parseLenient(body);
    const name = json?.name;
    const args = json?.arguments ?? json?.parameters;
    const only = json && Object.keys(json).every((k) => k === "name" || k === "arguments" || k === "parameters");
    if (typeof name === "string" && Object.hasOwn(this.schemas, name) && only && typeof args === "object" && args !== null && !Array.isArray(args)) {
      this.calls.push({ id: `${this.idPrefix}${this.calls.length}`, name, arguments: JSON.stringify(args) });
      this.#opening = "";
      return "";
    }
    const text = this.#opening + raw;
    this.#opening = "";
    return text;
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

/** Where the object that starts at `start` ends (its braces match, strings and their escapes counted), or -1. */
function objectEnd(text: string, start: number): number {
  let depth = 0, inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i]!;
    if (inString) { if (c === "\\") i++; else if (c === '"') inString = false; continue; }
    if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i;
  }
  return -1;
}

function coerce(value: string, type: string | undefined): unknown {
  if (type === undefined || type === "string") return value;
  try { return JSON.parse(value); } catch { return value; }
}

/**
 * A model that cannot call tools may write the command it wants run as a line that starts with `$ `. Only a block of such lines at the
 * very end of the reply counts, each at the start of its line, outside any fenced code block, and each starting like a command (a
 * word, a path): a `$` inside a sentence, a price, an example in the middle of an explanation or the shell prompt in a code block is
 * text. The commands are joined so that each runs only if the one before it worked. Nothing when there is no such block.
 */
export function dollarCommand(reply: string): string | undefined {
  const lines = reply.replace(/\s+$/, "").split(/\r?\n/);
  let fenced = false;
  for (const l of lines) if (/^\s*(```|~~~)/.test(l)) fenced = !fenced;
  if (fenced) return undefined;
  const found: string[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^\$ ([A-Za-z.\/~][^\n]*)$/.exec(lines[i]!);
    if (!m) break;
    found.unshift(m[1]!.trim());
  }
  if (!found.length) return undefined;
  // The block must not be inside a fence that closed above it either: look at the text before the block.
  let open = false;
  for (const l of lines.slice(0, lines.length - found.length)) if (/^\s*(```|~~~)/.test(l)) open = !open;
  return open ? undefined : found.join(" && ");
}
