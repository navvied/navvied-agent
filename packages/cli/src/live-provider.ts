import { ProviderError, type Provider } from "@navvied/engine";
import type { ModelReply, ModelRequest, StreamHandlers } from "@navvied/engine";
import type { ResolvedModel } from "./config.ts";
import type { Result } from "@navvied/protocol";

/**
 * A model whose key lives with what is saved for a provider or an endpoint (never in the model itself) is resolved again at every request: the next request after
 * the key was removed is refused in words, and the next one after a new key was saved carries the new key. The service object is kept while what it was made from
 * is the same, so a token it holds (a credential file's) is kept too.
 */
export class LiveProvider implements Provider {
  readonly readsPdf?: boolean;
  #kept: { signature: string; provider: Provider } | undefined;

  constructor(private readonly resolve: () => Result<ResolvedModel>, private readonly build: (m: ResolvedModel) => Provider, first: ResolvedModel) {
    if (first.pdf) this.readsPdf = true;
  }

  #current(): Provider {
    const now = this.resolve();
    // 401: a refusal that is not worth trying again, and the one a chain of second choices moves on from.
    if (!now.ok) throw new ProviderError(now.error, 401);
    const signature = JSON.stringify([now.value.provider, now.value.api, now.value.signIn, now.value.adc, now.value.window]);
    if (this.#kept?.signature !== signature) this.#kept = { signature, provider: this.build(now.value) };
    return this.#kept.provider;
  }

  async stream(req: ModelRequest, signal: AbortSignal, on: StreamHandlers): Promise<ModelReply> { return this.#current().stream(req, signal, on); }
  async complete(system: string, user: string, signal: AbortSignal, on?: Parameters<Provider["complete"]>[3]): Promise<string> { return this.#current().complete(system, user, signal, on); }
}
