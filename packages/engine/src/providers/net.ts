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
    if (late && !init.signal.aborted) {
      let host = url;
      try { host = new URL(url).host; } catch { /* keep the whole address */ }
      throw new ProviderError(`the model did not start answering within ${Math.round(waitMs / 1000)} seconds. Check that ${host} can be reached from this computer.`);
    }
    throw e;
  } finally { clearTimeout(timer); }
}
