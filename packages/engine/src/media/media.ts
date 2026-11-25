import { hostedProviders, type MediaServer } from "./client.ts";
import { findShrinker, type Shrinker } from "./fit.ts";
import { findRenderer, type Renderer } from "./render.ts";
import { localProviders, type Finders, type LocalConfig } from "./local.ts";
import type { MediaKind, MediaProvider, Need, VisionRoute } from "./types.ts";

export interface MediaOptions {
  /** The engines on this computer (see `LocalConfig`). */
  local?: LocalConfig;
  /** The service to ask for the rest, when this computer is signed in or the session has one. */
  server?: () => MediaServer | undefined;
  /** Injected for tests; the real one by default. */
  fetch?: typeof fetch;
  /** A model that sees pictures. */
  vision?: VisionRoute;
  /** Where a program is, by name: the real search of the path by default. */
  which?: (name: string) => string | undefined;
  /** The program that cuts a PDF page into a picture (default: `pdftoppm` on the path). */
  pdftoppm?: string;
}

/**
 * What can make, hear or look at media in this conversation, local first. A provider on this computer comes before the service; a provider that costs money is never used:
 * `withheld` says which kinds only a paid provider has, so a report can name them. The service's list is asked once and kept for the conversation (`refresh` asks again).
 */
export class Media {
  readonly #local: MediaProvider[];
  readonly #o: MediaOptions;
  #remote: MediaProvider[] = [];
  #asked: Promise<void> | undefined;
  #at = 0;
  /** Where the programs were found: the path is searched once for the life of this object. */
  readonly #found = new Map<string, string | undefined>();
  readonly #find: Finders;
  #renderer: { found: Renderer | undefined } | undefined;
  #shrinker: { found: Shrinker | undefined } | undefined;

  constructor(o: MediaOptions = {}) {
    this.#o = o;
    this.#find = { which: o.which ?? ((n) => Bun.which(n) ?? undefined) };
    this.#local = o.local ? localProviders(o.local, this.#find) : [];
  }

  /** Asks the service which kinds it has, when it was not asked in the last `maxAgeMs` (never again, by default). Never fails: a service that cannot be asked has none. */
  refresh(maxAgeMs = Infinity): Promise<void> {
    if (this.#asked && Date.now() - this.#at < maxAgeMs) return this.#asked;
    const server = this.#o.server?.();
    this.#at = Date.now();
    return (this.#asked = server ? hostedProviders(server, this.#o.fetch ?? fetch, AbortSignal.timeout(5_000)).then((p) => { this.#remote = p; }) : Promise.resolve());
  }

  /** The first provider of a kind that can run now, never a paid one. */
  pick<K extends MediaKind>(kind: K): MediaProvider<K> | undefined {
    return [...this.#local, ...this.#remote].find((p) => p.kind === kind && !p.paid && p.usable?.() !== false) as MediaProvider<K> | undefined;
  }

  /** Kinds that only a paid provider has: never offered, named so that they can be reported. */
  withheld(): MediaKind[] { return [...new Set(this.#remote.filter((p) => p.paid && !this.pick(p.kind)).map((p) => p.kind))]; }

  /** The program that cuts frames and sound out of recordings, or the one that draws a PDF page. */
  program(name: "ffmpeg" | "pdftoppm"): string | undefined {
    if (!this.#found.has(name)) this.#found.set(name, (name === "ffmpeg" ? this.#o.local?.ffmpeg : this.#o.pdftoppm) ?? this.#find.which(name));
    return this.#found.get(name);
  }

  /** The program that draws a PDF page (see `RENDERERS`), if this computer has one. */
  renderer(): Renderer | undefined {
    this.#renderer ??= { found: findRenderer(this.#find.which, this.#o.pdftoppm) };
    return this.#renderer.found;
  }

  /** The program that makes a picture smaller, if this computer has one. */
  shrinker(): Shrinker | undefined {
    this.#shrinker ??= { found: findShrinker(this.#find.which, this.program("ffmpeg")) };
    return this.#shrinker.found;
  }

  get look(): VisionRoute | undefined { return this.#o.vision; }

  has(need: Need): boolean {
    return need === "look" ? !!this.#o.vision : need === "watch" ? !!this.#o.vision && !!this.program("ffmpeg") : !!this.pick(need);
  }

  /** What the tools may use now, for the offering rules and for the list of tools a person sees. */
  needs(): Set<Need> { return new Set((["stt", "tts", "image", "video", "look", "watch"] as const).filter((n) => this.has(n))); }
}
