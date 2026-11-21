import type { EngineEvent } from "@navvied/protocol";

/**
 * The engine's own clock for the steps a program runs: a step starts when it is first seen, and the event that ends it says when that
 * was (`startedAt`, milliseconds since the epoch) and how long it took (`ms`). A page that is told this much never has to guess from when
 * the events reached it, which a relay that sends them together would make a span of nothing.
 */
export class StepClock {
  readonly #started = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  stamp(e: EngineEvent): EngineEvent {
    if (e.ev !== "tool") return e;
    const now = this.now();
    if (e.status === "running") { if (!this.#started.has(e.id)) this.#started.set(e.id, now); return e; }
    if (e.status !== "done" && e.status !== "error") return e;
    const at = this.#started.get(e.id) ?? now;
    this.#started.delete(e.id);
    return { ...e, startedAt: e.startedAt ?? at, ms: e.ms ?? Math.max(0, now - at) };
  }
}
