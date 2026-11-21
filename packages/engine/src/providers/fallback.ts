import { ProviderError } from "./chat-completions.ts";
import type { ModelReply, ModelRequest, Provider, RetryInfo, StreamHandlers } from "../types.ts";
import { RetryProvider, type RetryOptions } from "./retry.ts";

/** Whether another model may be tried: the model could not be reached or was overloaded or broken, not "your key is wrong" or "that request is not valid". */
export function worthAnother(e: unknown): boolean {
  if (e instanceof ProviderError) return e.status === undefined || e.status === 408 || e.status === 429 || e.status >= 500;
  return e instanceof TypeError || (e instanceof Error && /fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|network|socket|did not start answering/i.test(e.message));
}

export interface Link { name: string; provider: Provider }

/**
 * Models in order of preference: the first that can be reached answers. When one fails before it has said anything, the next one is
 * asked instead and the person is told once. A model that fails after it started answering is not replaced halfway: that would
 * mix two answers. The one that failed is tried first again on the next turn. Each model is tried again by itself first when that is
 * worth doing (busy, slow down, dropped), so the next one is asked only after those tries are used up.
 */
export class FallbackProvider implements Provider {
  readonly retries = true as const;
  private readonly chain: readonly Link[];

  constructor(chain: readonly Link[], private readonly told?: (message: string) => void, retry: RetryOptions = {}) {
    if (!chain.length) throw new Error("a fallback chain needs at least one model");
    this.chain = chain.map((l) => ({ name: l.name, provider: l.provider.retries ? l.provider : new RetryProvider(l.provider, retry) }));
  }

  get readsPdf(): boolean { return this.chain[0]!.provider.readsPdf === true; }

  async stream(req: ModelRequest, signal: AbortSignal, on: StreamHandlers): Promise<ModelReply> {
    let last: unknown;
    for (const [i, link] of this.chain.entries()) {
      let spoke = false;
      const watched: StreamHandlers = { ...on, text: (d) => { spoke = true; on.text(d); }, thought: (d) => { spoke = true; on.thought(d); }, toolStarted: (id, n) => { spoke = true; on.toolStarted(id, n); } };
      try { return await link.provider.stream(req, signal, watched); }
      catch (e) {
        last = e;
        if (spoke || signal.aborted || !worthAnother(e) || i === this.chain.length - 1) throw e;
        this.told?.(`${link.name} could not be reached (${e instanceof Error ? e.message.slice(0, 120) : "unknown"}). Using ${this.chain[i + 1]!.name} for this message.`);
      }
    }
    throw last;
  }

  async complete(system: string, user: string, signal: AbortSignal, on?: { retry?: (info: RetryInfo) => void }): Promise<string> {
    let last: unknown;
    for (const [i, link] of this.chain.entries()) {
      try { return await link.provider.complete(system, user, signal, on); }
      catch (e) { last = e; if (signal.aborted || !worthAnother(e) || i === this.chain.length - 1) throw e; }
    }
    throw last;
  }
}
