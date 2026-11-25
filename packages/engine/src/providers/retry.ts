import { ProviderError } from "./chat-completions.ts";
import type { ModelReply, ModelRequest, Provider, RetryInfo, StreamHandlers } from "../types.ts";

/** How many times a call is made in all (the first and the tries after it), and the most all the waiting may add up to. */
export const MAX_ATTEMPTS = 8;
export const MOST_WAIT_MS = 120_000;
const FIRST_WAIT_MS = 1_000;
const LONGEST_WAIT_MS = 30_000;

// A refused connection or an unknown name is not here: nobody is listening, and trying again for two minutes would only hide that.
const NETWORK = /fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|network|socket/i;

/**
 * Whether the same call is worth making again: the service was busy, asked to slow down, broke or took too long, or the connection
 * dropped. Never for an answer that says the request is wrong or the key is not accepted: trying again says the same.
 */
export function retryable(e: unknown): boolean {
  if (e instanceof ProviderError) return !e.spent && (e.status === 408 || e.status === 429 || (e.status !== undefined && e.status >= 500));
  return e instanceof TypeError || (e instanceof Error && NETWORK.test(e.message));
}

/** Why, in a few plain words, for the line that says the call is being tried again. */
export function reasonOf(e: unknown): string {
  const status = e instanceof ProviderError ? e.status : undefined;
  if (status === 429) return "the model asked to slow down";
  if (status === 529 || status === 503) return "the model is busy";
  if (status === 408) return "the model took too long to answer";
  if (status !== undefined && status >= 500) return "the model's server had a problem";
  return "the connection to the model dropped";
}

export interface RetryOptions {
  /** How many calls are made in all, the first one included (default `MAX_ATTEMPTS`; 1 means never again). */
  attempts?: number;
  /** Waits for `ms`, or until `signal` aborts. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** A number from 0 up to 1, for the spread of the waits. */
  random?: () => number;
}

const wait = (ms: number, signal: AbortSignal): Promise<void> => new Promise((done) => {
  if (signal.aborted) return done();
  const timer = setTimeout(() => { signal.removeEventListener("abort", stop); done(); }, ms);
  const stop = (): void => { clearTimeout(timer); done(); };
  signal.addEventListener("abort", stop, { once: true });
});

/**
 * The one place a call to a model is made again. Any provider can be put inside it. The service's own `Retry-After` is obeyed; without
 * one the wait doubles each time, spread so that many windows do not come back together. A call that already began to answer is never
 * made again silently: what was said is on a screen. Stopping ends the wait at once. Each wait is announced first, through
 * `on.retry`, so a screen can say so.
 */
export class RetryProvider implements Provider {
  readonly retries = true as const;
  readonly #sleep: NonNullable<RetryOptions["sleep"]>;
  readonly #random: () => number;
  readonly #attempts: number;

  constructor(private readonly inner: Provider, o: RetryOptions = {}) {
    this.#sleep = o.sleep ?? wait;
    this.#random = o.random ?? Math.random;
    this.#attempts = Math.max(1, Math.floor(o.attempts ?? MAX_ATTEMPTS));
  }

  get readsPdf(): boolean { return this.inner.readsPdf === true; }

  async stream(req: ModelRequest, signal: AbortSignal, on: StreamHandlers): Promise<ModelReply> {
    let spoke = false;
    const watched: StreamHandlers = { ...on, text: (d) => { spoke = true; on.text(d); }, thought: (d) => { spoke = true; on.thought(d); }, toolStarted: (id, n) => { spoke = true; on.toolStarted(id, n); } };
    return this.#again(signal, on.retry, () => spoke, () => this.inner.stream(req, signal, watched));
  }

  complete(system: string, user: string, signal: AbortSignal, on?: { retry?: (info: RetryInfo) => void }): Promise<string> {
    return this.#again(signal, on?.retry, () => false, () => this.inner.complete(system, user, signal));
  }

  async #again<T>(signal: AbortSignal, told: ((info: RetryInfo) => void) | undefined, spoke: () => boolean, call: () => Promise<T>): Promise<T> {
    let waited = 0;
    for (let attempt = 1; ; attempt++) {
      try { return await call(); }
      catch (e) {
        if (signal.aborted || spoke() || !retryable(e) || attempt >= this.#attempts) throw e;
        const asked = e instanceof ProviderError ? e.retryAfterMs : undefined;
        const ms = asked ?? Math.min(LONGEST_WAIT_MS, FIRST_WAIT_MS * 2 ** (attempt - 1)) * (0.75 + this.#random() * 0.5);
        if (waited + ms > MOST_WAIT_MS) throw e;
        waited += ms;
        told?.({ reason: reasonOf(e), attempt: attempt + 1, of: this.#attempts, inSeconds: Math.max(1, Math.ceil(ms / 1000)) });
        await this.#sleep(ms, signal);
        if (signal.aborted) throw e;
      }
    }
  }
}
