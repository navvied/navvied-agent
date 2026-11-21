import { ProviderError } from "./chat-completions.ts";

/** How long a model may take to start answering before the person is told. A small model on a slow computer can need a while to read a long conversation, so this is generous. */
export const FIRST_ANSWER_MS = 180_000;

/**
 * `fetch` for a model: when nothing comes back in time, the call ends with a plain sentence about reaching the model, instead of
 * leaving the screen on "Thinking…" for ever. Only the wait for the start of the answer is limited, never the answer itself.
 */
export async function fetchModel(url: string, init: RequestInit & { signal: AbortSignal }, waitMs: number = FIRST_ANSWER_MS): Promise<Response> {
  const ours = new AbortController();
  let late = false;
  const timer = setTimeout(() => { late = true; ours.abort(); }, waitMs);
  try {
    return await fetch(url, { ...init, signal: AbortSignal.any([init.signal, ours.signal]) });
  } catch (e) {
    // Nobody is listening there, or the name is not known: that is not a hiccup that passes, so it is said plainly, with the address, and not tried again.
    const code = (e as { code?: string }).code ?? (e as { cause?: { code?: string } }).cause?.code;
    if (code === "ECONNREFUSED" || code === "ENOTFOUND") {
      let origin = url;
      try { origin = new URL(url).origin; } catch { /* keep the whole address */ }
      throw new ProviderError(code === "ECONNREFUSED" ? `Nothing answers at ${origin}. Start the model server, then send again.` : `The address ${origin} was not found. Check it in the settings, then send again.`);
    }
    if (late && !init.signal.aborted) {
      let host = url;
      try { host = new URL(url).host; } catch { /* keep the whole address */ }
      throw new ProviderError(`the model did not start answering within ${Math.round(waitMs / 1000)} seconds. Check that ${host} can be reached from this computer.`);
    }
    throw e;
  } finally { clearTimeout(timer); }
}

/** How long the service asked to wait before another try (`Retry-After`: seconds, or a date), in milliseconds; nothing when it did not say. */
export function retryAfterMs(res: Response, now: number = Date.now()): number | undefined {
  const raw = res.headers.get("retry-after")?.trim();
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  const at = Date.parse(raw);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/** The status an error that came inside an answer stands for, from the kind the service named: it was busy, it asked to slow down, or it broke. */
export function statusOfKind(kind: string | undefined): number | undefined {
  if (!kind) return undefined;
  if (/overload/i.test(kind)) return 529;
  if (/rate.?limit/i.test(kind)) return 429;
  if (/server_error|api_error|internal/i.test(kind)) return 500;
  return undefined;
}
