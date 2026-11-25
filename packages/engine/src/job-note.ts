import type { News } from "./jobs.ts";

/** What the model is told of a command that ended or printed what it watched for: one bracketed line each. */
export function jobLines(n: News): string[] {
  const secs = `${(n.ms / 1000).toFixed(1)} s`;
  const lines: string[] = [];
  if (n.ended) {
    const ran = n.status === "done" || n.status === "failed";
    lines.push(`[${n.id} ${ran ? (n.code === null ? "finished, how it ended is not known" : `finished: exit ${n.code}`) : n.status}, ${secs}; BashOutput ${n.id} for the rest]`);
  }
  if (n.hit !== undefined) lines.push(`[${n.id} printed ${JSON.stringify(n.hit)}${n.lastHit ? " (it does not wake you again)" : ""}; BashOutput ${n.id} for the rest]`);
  return lines;
}

/** The message that starts a turn when a command ended or printed what was watched for while nobody was writing: the lines, and the end of what each printed. */
export function wakeText(news: readonly News[], tail: (id: string) => string): string {
  return news.map((n) => [...jobLines(n), tail(n.id)].filter(Boolean).join("\n")).join("\n\n");
}
