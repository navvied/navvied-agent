/**
 * What a provider of speech, pictures or video is. The kinds are the server's own names (`GET /v1/media`); a provider is a program on this computer or a service, and the
 * tools never know which: they ask `Media` for the first one that is ready and send it a request.
 */
export type MediaKind = "stt" | "tts" | "image" | "video";
/** What a tool needs: a provider of a kind, or a model that sees pictures (`look`), or that and a program that cuts frames (`watch`). */
export type Need = MediaKind | "look" | "watch";

/** Files go by path, so a long recording is never held whole in memory by this side. */
export interface Requests {
  stt: { path: string; language?: string };
  tts: { text: string };
  image: { prompt: string; size?: string; reference?: string };
  video: { prompt: string; seconds?: number; image?: string };
}
export interface Sound { bytes: Uint8Array; mime: string; /** The length in seconds, when the provider says it. */ seconds?: number }
export interface Answers { stt: { text: string }; tts: Sound; image: Sound; video: Sound }

/** A failure a person can be told in one sentence. */
export class MediaError extends Error {}

export interface MediaProvider<K extends MediaKind = MediaKind> {
  readonly kind: K;
  readonly id: string;
  /** Costs money to use. A provider that is paid is never offered (see `Media`). */
  readonly paid: boolean;
  /** Runs on this computer. */
  readonly local: boolean;
  /** Whether it can run now (its program and model files are there); not set: always. */
  usable?(): boolean;
  run(req: Requests[K], signal: AbortSignal): Promise<Answers[K]>;
}

/** Asks a model that sees pictures about them and returns its answer as text. */
export type VisionRoute = (ask: { images: { mime: string; data: string }[]; question: string }, signal: AbortSignal) => Promise<string>;
