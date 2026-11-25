import type { ScheduleRunInfo } from "@navvied/protocol";
import { redact } from "./redact.ts";
import type { ScheduleRun } from "./types.ts";

const MOST_SAID = 200;

/** What a run said, short and safe to show: secrets hidden, white space folded, at most 200 characters. None when nothing is left. */
export function saidOf(text: string | undefined): string | undefined {
  const one = redact(text ?? "").replace(/\s+/g, " ").trim();
  if (!one) return undefined;
  return one.length > MOST_SAID ? `${one.slice(0, MOST_SAID - 1)}…` : one;
}

const OUTCOME: Record<ScheduleRun["outcome"], ScheduleRunInfo["outcome"]> = { ok: "fine", failed: "failed", missed: "missed", running: "running" };

/** A cloud job's run (`/v1/schedule` `runs`) in the shape the screens use. */
export function runInfoOfCloud(r: ScheduleRun): ScheduleRunInfo {
  const said = saidOf(r.note);
  return { at: r.at, outcome: OUTCOME[r.outcome], ...(r.due !== undefined ? { due: r.due } : {}), ...(said ? { said } : {}) };
}
