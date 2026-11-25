import { readFileSync, statSync } from "node:fs";
import { unreachedSentence, whyUnreached } from "../tools/web-errors.ts";
import { MediaError, type Answers, type MediaKind, type MediaProvider, type Requests } from "./types.ts";

/** Where the media routes of a service are (up to and including `/v1/media` or `/api/media`) and the token to ask with. */
export interface MediaServer { url: string; token?: string }

/** What the service takes in one request (docs/HOSTED.md): audio at most 25 MB, a reference picture at most 10 MB. */
const MOST_AUDIO = 25_000_000, MOST_PICTURE = 10_000_000, MOST_ANSWER = 200_000_000;
/** How long each kind may take, a little more than the service allows itself. */
const WAIT: Record<MediaKind, number> = { tts: 90_000, stt: 330_000, image: 210_000, video: 930_000 };
const KINDS: readonly MediaKind[] = ["tts", "stt", "image", "video"];

const megabytes = (n: number): string => `${Math.round(n / 1_000_000)} MB`;

function base64Of(path: string, most: number, what: string): string {
  const size = statSync(path).size;
  if (size > most) throw new MediaError(`${what} is ${megabytes(size)}; the service takes at most ${megabytes(most)}. Cut it shorter first.`);
  return readFileSync(path).toString("base64");
}

/** Asks the service one thing and returns the answer; every failure is one sentence, the service's own when it gave one. */
async function ask(server: MediaServer, f: typeof fetch, method: "GET" | "POST", route: string, body: unknown, signal: AbortSignal, ms: number): Promise<Response> {
  let res: Response;
  try {
    res = await f(`${server.url.replace(/\/+$/, "")}${route}`, {
      method, signal: AbortSignal.any([signal, AbortSignal.timeout(ms)]),
      headers: { accept: "*/*", ...(body === undefined ? {} : { "content-type": "application/json" }), ...(server.token ? { authorization: `Bearer ${server.token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (e) {
    if (signal.aborted) throw new MediaError("It was stopped.");
    throw new MediaError(unreachedSentence(whyUnreached(e), "The media service"));
  }
  if (res.ok) return res;
  const said = ((await res.json().catch(() => undefined)) as { error?: { message?: unknown } } | undefined)?.error?.message;
  throw new MediaError(typeof said === "string" && said ? said : res.status === 401 ? "The media service did not accept this computer's sign-in. Sign in again." : `The media service answered ${res.status}.`);
}

async function bytesOf(res: Response): Promise<{ bytes: Uint8Array; mime: string; seconds?: number }> {
  if (Number(res.headers.get("content-length")) > MOST_ANSWER) throw new MediaError(`The media service's answer is larger than ${megabytes(MOST_ANSWER)}.`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (!bytes.length) throw new MediaError("The media service answered with nothing.");
  if (bytes.length > MOST_ANSWER) throw new MediaError(`The media service's answer is larger than ${megabytes(MOST_ANSWER)}.`);
  const seconds = Number(res.headers.get("x-navvied-seconds"));
  return { bytes, mime: res.headers.get("content-type")?.split(";")[0]?.trim() || "application/octet-stream", ...(Number.isFinite(seconds) && seconds > 0 ? { seconds } : {}) };
}

function provider<K extends MediaKind>(server: MediaServer, f: typeof fetch, kind: K, paid: boolean): MediaProvider<K> {
  const call = async (req: Requests[K], signal: AbortSignal): Promise<Answers[K]> => {
    const r = req as Record<string, unknown>;
    if (kind === "stt") {
      const q = req as Requests["stt"];
      const res = await ask(server, f, "POST", "/stt", { audio: base64Of(q.path, MOST_AUDIO, "The recording"), ...(q.language ? { language: q.language } : {}) }, signal, WAIT.stt);
      const text = ((await res.json().catch(() => undefined)) as { text?: unknown } | undefined)?.text;
      if (typeof text !== "string") throw new MediaError("The media service did not answer with text.");
      return { text } as Answers[K];
    }
    const body = kind === "tts" ? { text: r.text }
      : kind === "image" ? { prompt: r.prompt, ...(r.size ? { size: r.size } : {}), ...(r.reference ? { reference: base64Of(r.reference as string, MOST_PICTURE, "The reference picture") } : {}) }
      : { prompt: r.prompt, ...(r.seconds ? { seconds: r.seconds } : {}), ...(r.image ? { image: base64Of(r.image as string, MOST_PICTURE, "The first picture") } : {}) };
    return (await bytesOf(await ask(server, f, "POST", `/${kind}`, body, signal, WAIT[kind]))) as Answers[K];
  };
  return { kind, id: "navvied", paid, local: false, run: call };
}

/**
 * The providers a service has right now: `GET` the list (only the kinds that work), one provider per kind, each saying whether it costs money. Nothing is kept here: the
 * caller keeps the list for the conversation. A service that cannot be asked has no providers.
 */
export async function hostedProviders(server: MediaServer, f: typeof fetch, signal: AbortSignal): Promise<MediaProvider[]> {
  try {
    const res = await ask(server, f, "GET", "", undefined, signal, 10_000);
    const list = ((await res.json()) as { tools?: unknown }).tools;
    if (!Array.isArray(list)) return [];
    return list.flatMap((t: unknown): MediaProvider[] => {
      const kind = (t as { kind?: unknown } | null)?.kind, paid = (t as { provider?: unknown }).provider === "paid";
      return KINDS.includes(kind as MediaKind) ? [provider(server, f, kind as MediaKind, paid)] : [];
    });
  } catch { return []; }
}
