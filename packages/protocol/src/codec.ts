/** JSON-lines encoding: one JSON object per line, UTF-8, `\n` terminated. */
import type { Command, EngineEvent, Result, Stamped } from "./types.ts";
import { validateCommand } from "./validate.ts";

/** Longest line the decoder accepts (a prompt with images is the largest legitimate message). */
export const MAX_LINE = 64 * 1024 * 1024;

export const encodeCommand = (c: Command): string => JSON.stringify(c) + "\n";

/** Stamps events with a sequence number and a unique id, then serialises them. One per engine process/session. */
export class EventEncoder {
  #seq = 0;
  get seq(): number { return this.#seq; }
  stamp<E extends EngineEvent>(e: E): Stamped<E> {
    this.#seq += 1;
    return { ...e, seq: this.#seq, eid: `e${this.#seq}` };
  }
  encode(e: EngineEvent): string { return JSON.stringify(this.stamp(e)) + "\n"; }
}

/** Parse one line into a validated command. Never throws. */
export function parseCommand(line: string): Result<Command> {
  let raw: unknown;
  try { raw = JSON.parse(line); } catch { return { ok: false, error: "not valid JSON" }; }
  return validateCommand(raw);
}

/**
 * Parse one line into an event. Unknown event names are returned as-is (forward compatibility): a front-end ignores
 * what it does not understand. Only the envelope is checked.
 */
export function parseEvent(line: string): Result<Stamped> {
  let raw: unknown;
  try { raw = JSON.parse(line); } catch { return { ok: false, error: "not valid JSON" }; }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, error: "an event must be a JSON object" };
  const o = raw as Record<string, unknown>;
  if (typeof o.ev !== "string") return { ok: false, error: "missing ev" };
  return { ok: true, value: o as unknown as Stamped };
}

export class LineSplitter {
  #buf = "";
  /** Feed a chunk; returns the complete, non-empty lines it finished. Throws if one line exceeds {@link MAX_LINE}. */
  push(chunk: string): string[] {
    this.#buf += chunk;
    const out: string[] = [];
    let i: number;
    while ((i = this.#buf.indexOf("\n")) >= 0) {
      const line = this.#buf.slice(0, i).trim();
      this.#buf = this.#buf.slice(i + 1);
      if (line) out.push(line);
    }
    if (this.#buf.length > MAX_LINE) { this.#buf = ""; throw new RangeError("protocol line too long"); }
    return out;
  }
  flush(): string[] {
    const rest = this.#buf.trim();
    this.#buf = "";
    return rest ? [rest] : [];
  }
}

/** Remembers the most recent prompt ids, so a prompt re-sent after a reconnect is recognised and ignored. */
export class RecentIds {
  readonly #seen = new Set<string>();
  constructor(readonly limit = 1000) {}
  /** True the first time an id is offered, false for every repeat. */
  isNew(id: string): boolean {
    if (this.#seen.has(id)) return false;
    this.#seen.add(id);
    if (this.#seen.size > this.limit) this.#seen.delete(this.#seen.values().next().value as string);
    return true;
  }
}
