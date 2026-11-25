/**
 * What a measurement is expected to cost, before any token is spent. The size of the first request of each task and arm is measured
 * (a dry run, with the scripted model, through the real program); how many calls a typical model needs and how much each step adds to the
 * conversation are ASSUMED, task by task, from what the reference solutions do. Change a number here and the estimate follows.
 */

export type Style = "stepwise" | "scripted" | "code";

/** Model calls a task takes in a style, and the tokens each step adds to the conversation (the call that was written and what came back). */
interface Shape { calls: number; added: number }

/**
 * - stepwise: one tool call for each file or page, as the task is built to need (what a model does that does not write programs);
 * - scripted: the model writes a program and runs it with Bash: look around, write it, run it, check, answer;
 * - code: the same, with the code tool: look around, one script, check, answer.
 */
export const ASSUMED: Record<string, Record<Style, Shape>> = {
  "mc-aggregate-json": { stepwise: { calls: 64, added: 150 }, scripted: { calls: 6, added: 500 }, code: { calls: 5, added: 450 } },
  "mc-paginated-api": { stepwise: { calls: 16, added: 900 }, scripted: { calls: 7, added: 500 }, code: { calls: 5, added: 450 } },
  "mc-migrate-calls": { stepwise: { calls: 40, added: 250 }, scripted: { calls: 8, added: 500 }, code: { calls: 6, added: 500 } },
  "mc-triage-logs": { stepwise: { calls: 22, added: 1200 }, scripted: { calls: 7, added: 500 }, code: { calls: 5, added: 450 } },
  "mc-import-cycles": { stepwise: { calls: 34, added: 250 }, scripted: { calls: 8, added: 500 }, code: { calls: 6, added: 500 } },
  "mc-config-diff": { stepwise: { calls: 84, added: 220 }, scripted: { calls: 8, added: 500 }, code: { calls: 6, added: 500 } },
  // The second measurement. The data is behind connected programs and the fixture web, so a
  // model that writes programs with Bash cannot reach it: "scripted" is the same as "stepwise", except where a page can be fetched by
  // a command (compare-pages). The code arm: the script, a fix when it fails once, the answer.
  "mc2-fan-out": { stepwise: { calls: 46, added: 810 }, scripted: { calls: 46, added: 810 }, code: { calls: 3, added: 400 } },
  "mc2-page-walk": { stepwise: { calls: 36, added: 790 }, scripted: { calls: 36, added: 790 }, code: { calls: 3, added: 400 } },
  "mc2-ticket-pipeline": { stepwise: { calls: 27, added: 705 }, scripted: { calls: 27, added: 705 }, code: { calls: 3, added: 400 } },
  "mc2-compare-pages": { stepwise: { calls: 15, added: 1500 }, scripted: { calls: 5, added: 600 }, code: { calls: 3, added: 400 } },
  "mc2-pages-to-accounts": { stepwise: { calls: 27, added: 1220 }, scripted: { calls: 27, added: 1220 }, code: { calls: 3, added: 400 } },
  "mc2-first-account": { stepwise: { calls: 4, added: 143 }, scripted: { calls: 4, added: 143 }, code: { calls: 3, added: 400 } },
};

/** Tokens a model writes for one call of its own, and for the one program it writes in the styles that write one. */
const CALL_TOKENS = 70;
const PROGRAM_TOKENS = 400;
/** What a model working stepwise must write by hand for the answer itself (the file it hands in), where a program would write it. */
const BY_HAND: Record<string, number> = { "mc-aggregate-json": 60, "mc-paginated-api": 3600, "mc-migrate-calls": 0, "mc-triage-logs": 300, "mc-import-cycles": 150, "mc-config-diff": 1200, "mc2-fan-out": 60, "mc2-page-walk": 40, "mc2-ticket-pipeline": 450, "mc2-compare-pages": 10, "mc2-pages-to-accounts": 450, "mc2-first-account": 20 };

export interface Estimate { task: string; style: Style; calls: number; inTokens: number; outTokens: number }

/** One run: every call sends the whole conversation so far (the first request, then what each step added), and writes a short call. */
export function estimateRun(task: string, style: Style, firstRequestTokens: number): Estimate {
  const { calls, added } = ASSUMED[task]![style];
  return {
    task, style, calls,
    inTokens: Math.round(calls * firstRequestTokens + (added * calls * (calls - 1)) / 2),
    outTokens: calls * CALL_TOKENS + (style === "stepwise" ? BY_HAND[task]! : PROGRAM_TOKENS),
  };
}

export interface Total { calls: number; tokens: number; minutes: number }

/** Over every task, `repeat` times each, for the styles of the two arms the way the comparison runs them. */
export function total(estimates: readonly Estimate[], repeat: number, perMinute: number): Total {
  const calls = estimates.reduce((n, e) => n + e.calls, 0) * repeat;
  return { calls, tokens: estimates.reduce((n, e) => n + e.inTokens + e.outTokens, 0) * repeat, minutes: calls / perMinute };
}

/** The table of the estimate, as text. `first` is the first request of each task in each arm, measured. */
export function estimateTable(first: Record<string, { base: number; code: number }>, repeat: number, perMinute: number): string {
  const tasks = Object.keys(first).filter((t) => t in ASSUMED);
  const rows = tasks.map((t) => ({ t, step: estimateRun(t, "stepwise", first[t]?.base ?? 0), script: estimateRun(t, "scripted", first[t]?.base ?? 0), code: estimateRun(t, "code", first[t]?.code ?? 0) }));
  const cell = (e: Estimate): string => `${e.calls} calls, ${(e.inTokens + e.outTokens).toLocaleString("en-US")} tokens`;
  const lines = ["| task | first request base / code | base, stepwise | base, scripted | code |", "|---|---|---|---|---|"];
  for (const r of rows) lines.push(`| ${r.t} | ${first[r.t]?.base ?? 0} / ${first[r.t]?.code ?? 0} | ${cell(r.step)} | ${cell(r.script)} | ${cell(r.code)} |`);
  const sums = { stepwise: total(rows.map((r) => r.step), repeat, perMinute), scripted: total(rows.map((r) => r.script), repeat, perMinute), code: total(rows.map((r) => r.code), repeat, perMinute) };
  const all = (base: Total): string => `${base.calls + sums.code.calls} calls, ${(base.tokens + sums.code.tokens).toLocaleString("en-US")} tokens, ${Math.ceil(base.minutes + sums.code.minutes)} minutes at ${perMinute} requests a minute`;
  lines.push("", `For ${tasks.length} tasks, both arms, ${repeat} repeats:`, `  if the base arm works stepwise:  ${all(sums.stepwise)}`, `  if the base arm writes programs: ${all(sums.scripted)}`);
  return lines.join("\n");
}
