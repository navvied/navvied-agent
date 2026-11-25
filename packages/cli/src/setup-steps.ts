import type { SetupStep } from "@navvied/protocol";

/** One thing a setup fetches, in the order it is fetched. */
export interface SetupItem { name: string; size: number }

/** Where a setup is: still to come (`ask`), at a place in the work (`file` is the thing being worked on, `bytes` of the whole so far), or ended. */
export type SetupAt = { at: "ask" } | { at: "work"; file?: string; bytes: number } | { at: "done" } | { at: "failed"; file?: string; bytes: number } | { at: "paused"; file?: string; bytes: number };

/** The state of every step of a setup, and how far it is as a whole (0 to 100). The steps are worked on one after the other, so those before the one being worked on are done and those after it wait. */
export function stepsOf(items: readonly SetupItem[], where: SetupAt): { steps: SetupStep[]; percent: number } {
  const total = items.reduce((n, i) => n + i.size, 0);
  if (where.at === "done") return { steps: items.map((i) => ({ name: i.name, state: "done", bytes: i.size, total: i.size })), percent: 100 };
  if (where.at === "ask") return { steps: items.map((i) => ({ name: i.name, state: "waiting", bytes: 0, total: i.size })), percent: 0 };
  let start = 0, active = items.findIndex((i) => i.name === where.file);
  if (active < 0) { let sum = 0; active = items.findIndex((i) => (sum += i.size) > where.bytes); if (active < 0) active = items.length - 1; }
  const steps = items.map((i, n): SetupStep => {
    const from = start;
    start += i.size;
    if (n < active) return { name: i.name, state: "done", bytes: i.size, total: i.size };
    if (n > active) return { name: i.name, state: "waiting", bytes: 0, total: i.size };
    const into = Math.max(0, Math.min(i.size, where.bytes - from));
    return { name: i.name, state: where.at === "failed" ? "failed" : where.at === "paused" ? "waiting" : "active", bytes: into, total: i.size };
  });
  return { steps, percent: total ? Math.max(0, Math.min(100, Math.floor((100 * where.bytes) / total))) : 0 };
}
