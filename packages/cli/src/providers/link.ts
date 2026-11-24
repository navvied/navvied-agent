import type { EngineEvent } from "@navvied/protocol";

/** What the screens of the providers need from the hub: a command with its answer (or the sentence that says why not), a command alone, and the events as they come. */
export interface Link {
  call<E extends EngineEvent["ev"]>(ev: E, cmd: object): Promise<Extract<EngineEvent, { ev: E }> | string>;
  send(cmd: object): void;
  watch(fn: (e: EngineEvent) => void): () => void;
}

type Waiter = { ev: string; resolve: (answer: never) => void };

/** Events that belong to these screens alone: a conversation never says them. */
const OWN = (ev: string): boolean => ev === "machine" || ev.startsWith("account") || ev === "providers" || ev === "endpoints" || ev === "endpoint.models" || ev === "provider.models" || ev.startsWith("local.");

/** Sends commands to the hub and matches its events to them. An `error` answers the oldest command still waiting, so a screen can say it itself. */
export class HubLink implements Link {
  #calls: Waiter[] = [];
  #asks: Waiter[] = [];
  #watchers = new Set<(e: EngineEvent) => void>();

  constructor(readonly send: (cmd: object) => void) {}

  /** A command whose answer is the next event of that name; an error of the hub is left to the conversation. */
  ask<E extends EngineEvent["ev"]>(ev: E, cmd: object, then: (e: Extract<EngineEvent, { ev: E }>) => void): void {
    this.#asks.push({ ev, resolve: then as (answer: never) => void });
    this.send(cmd);
  }

  call<E extends EngineEvent["ev"]>(ev: E, cmd: object): Promise<Extract<EngineEvent, { ev: E }> | string> {
    return new Promise((resolve) => { this.#calls.push({ ev, resolve }); this.send(cmd); });
  }

  watch(fn: (e: EngineEvent) => void): () => void {
    this.#watchers.add(fn);
    return () => { this.#watchers.delete(fn); };
  }

  /** Returns true when the event was for a screen and the conversation should not show it. */
  onEvent(e: EngineEvent): boolean {
    for (const fn of this.#watchers) fn(e);
    if (e.ev === "error") {
      const first = this.#calls.shift();
      if (!first) return false;
      (first.resolve as (answer: string) => void)(e.msg);
      return true;
    }
    for (const list of [this.#calls, this.#asks]) {
      for (const w of list.filter((x) => x.ev === e.ev)) { list.splice(list.indexOf(w), 1); (w.resolve as (answer: EngineEvent) => void)(e); }
    }
    return OWN(e.ev);
  }
}
