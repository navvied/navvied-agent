import { execFile } from "@navvied/engine";
import { existsSync } from "node:fs";
import { ChatCompletionsProvider, ProviderError, type ModelReply, type ModelRequest, type Provider, type StreamHandlers } from "@navvied/engine";
import { reapOrphan, startServer, type RunningServer } from "./llama-server.ts";
import type { LocalVisionConfig } from "./media-config.ts";

const WINDOW = 8192;
const ALIAS = "vision";

const asked = (argv: string[]): Promise<{ code: number; output: string }> =>
  new Promise((resolve) => { execFile(argv[0]!, argv.slice(1), { timeout: 5000 }, (e, out) => { resolve({ code: e ? 1 : 0, output: String(out) }); }); });

export interface LocalVisionOptions {
  /** Where the note of the server's process is kept, so one left behind by a crash is found. */
  pidFile: string;
  /** How long the server is kept after its last question. */
  idleMs?: number;
  start?: typeof startServer;
}

/**
 * A model that looks at pictures, run on this computer by the program's own model server, on the processor alone. The server is started by the first question, kept for a
 * while for the next ones, and stopped when it is idle or when this program ends, so nothing runs while nobody looks at anything.
 */
export class LocalVision implements Provider {
  readonly #c: LocalVisionConfig;
  readonly #o: LocalVisionOptions;
  #up: Promise<{ server: RunningServer; chat: ChatCompletionsProvider } | { error: string }> | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #busy = 0;

  constructor(c: LocalVisionConfig, o: LocalVisionOptions) { this.#c = c; this.#o = o; }

  /** Whether the program and both files are there: until they are, no one is offered a model that cannot run. */
  get ready(): boolean { return [this.#c.server, this.#c.model, this.#c.mmproj].every((p) => existsSync(p)); }

  async #chat(): Promise<ChatCompletionsProvider> {
    this.#up ??= (async () => {
      await reapOrphan(this.#o.pidFile, asked).catch(() => undefined);
      const server = await (this.#o.start ?? startServer)({ binary: this.#c.server, model: this.#c.model, mmproj: this.#c.mmproj, window: WINDOW, layers: 0, alias: ALIAS, pidFile: this.#o.pidFile });
      if ("error" in server) return server;
      void server.exited.then(() => { this.#up = undefined; });
      return { server, chat: new ChatCompletionsProvider({ baseUrl: `${server.url}/v1`, model: ALIAS, reasoning: "none" }) };
    })();
    const up = await this.#up;
    if ("error" in up) { this.#up = undefined; throw new ProviderError(up.error); }
    return up.chat;
  }

  async #use<T>(f: (p: ChatCompletionsProvider) => Promise<T>): Promise<T> {
    clearTimeout(this.#timer);
    this.#busy++;
    try { return await f(await this.#chat()); } finally {
      this.#busy--;
      if (!this.#busy) { this.#timer = setTimeout(() => { void this.close(); }, this.#o.idleMs ?? 120_000); this.#timer.unref?.(); }
    }
  }

  stream(req: ModelRequest, signal: AbortSignal, on: StreamHandlers): Promise<ModelReply> { return this.#use((p) => p.stream(req, signal, on)); }
  complete(system: string, user: string, signal: AbortSignal): Promise<string> { return this.#use((p) => p.complete(system, user, signal)); }

  async close(): Promise<void> {
    clearTimeout(this.#timer);
    const up = await this.#up;
    this.#up = undefined;
    if (up && !("error" in up)) await up.server.stop();
  }
}

const kept = new Map<string, LocalVision>();

/** One server for one configuration however often the tools ask for the model; undefined while a file it needs is missing. */
export function localVision(c: LocalVisionConfig, pidFile: string): LocalVision | undefined {
  const key = JSON.stringify([c, pidFile]);
  let v = kept.get(key);
  if (!v) kept.set(key, (v = new LocalVision(c, { pidFile })));
  return v.ready ? v : undefined;
}

/** Stops every picture model this program started (the hub ends with them). */
export async function closeLocalVisions(): Promise<void> {
  const all = [...kept.values()];
  kept.clear();
  await Promise.all(all.map((v) => v.close()));
}
