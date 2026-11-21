import type { Message, Provider, RetryInfo } from "./types.ts";

/** Rough token estimate when the provider reports no usage (≈ 3.6 characters per token for mixed code and prose). */
export const estimateTokens = (messages: readonly Message[]): number => Math.ceil(JSON.stringify(messages).length / 3.6);

export const COMPACT_AT = 0.85;
export const shouldCompact = (used: number, window: number): boolean => used > window * COMPACT_AT;

export const KEEP_TAIL = 4;
const SUMMARY_SYSTEM =
  "Summarise this conversation between a user and a coding agent so the work can continue from the summary alone. " +
  "Keep: the goal, decisions, files touched and why, commands run and their results, errors and fixes, open tasks, and exact " +
  "names, paths and values. Be dense. No preamble.";

const asText = (m: Message): string =>
  typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map((p) => (p.type === "text" ? p.text : "[image]")).join(" ") : JSON.stringify(m.toolCalls ?? "");

/**
 * Replace everything but the last few messages with a summary. Returns null when there is too little to summarise.
 * Throws if the provider cannot produce a summary (the caller keeps the conversation as it was).
 */
export async function compactMessages(messages: Message[], provider: Provider, signal: AbortSignal, keep: number = KEEP_TAIL, on?: { retry?: (info: RetryInfo) => void }): Promise<Message[] | null> {
  if (messages.length < keep + 2) return null;
  let cut = messages.length - keep;
  while (cut < messages.length && messages[cut]?.role === "tool") cut++; // never start the kept tail with an orphaned tool result
  if (cut >= messages.length) return null;
  const transcript = messages.slice(0, cut).map((m) => `${m.role.toUpperCase()}: ${asText(m)}`).join("\n\n").slice(-120_000);
  const summary = (await provider.complete(SUMMARY_SYSTEM, transcript, signal, on)).trim();
  return [
    { role: "user", content: `[Summary of the earlier conversation]\n${summary}` },
    { role: "assistant", content: "Understood — continuing from that summary." },
    ...messages.slice(cut),
  ];
}
