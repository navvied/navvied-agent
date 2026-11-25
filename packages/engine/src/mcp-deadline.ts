/** A time limit that can be held while the other side is waiting for the person (a question), and started again after. */
export class Deadline {
  readonly #stop = new AbortController();
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(readonly ms: number) { this.resume(); }

  get signal(): AbortSignal { return this.#stop.signal; }
  get expired(): boolean { return this.#stop.signal.aborted; }

  pause(): void { clearTimeout(this.#timer); }
  resume(): void { this.pause(); if (!this.expired) this.#timer = setTimeout(() => this.#stop.abort(), this.ms); }
  /** Finished: nothing is waited for any more. */
  end(): void { this.pause(); }
}
