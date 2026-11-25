import type { TaskResult } from "./run.ts";
import { rate } from "./stats.ts";

/** One run of the comparison: which arm and which repeat it was, besides what the run measured. */
export interface AbRun extends TaskResult { arm: string; repeat: number }

export const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** What is compared, and how a run gives it. Time is the agent's own: what the counter waited for the service's rate is taken out. */
const METRICS: { name: string; of: (r: AbRun) => number; digits: number }[] = [
  { name: "model calls", of: (r) => r.modelCalls, digits: 1 },
  { name: "tokens (in + out)", of: (r) => (r.inTokens ?? 0) + r.outTokens, digits: 0 },
  { name: "seconds", of: (r) => (r.ms - (r.waitedMs ?? 0)) / 1000, digits: 1 },
  { name: "tool calls (model + scripts)", of: (r) => r.toolCalls + (r.nestedCalls ?? 0), digits: 1 },
];

const num = (x: number, digits: number): string => (digits ? x.toFixed(digits) : Math.round(x).toLocaleString("en-US"));
const signed = (x: number, digits: number): string => `${x > 0 ? "+" : ""}${num(x, digits)}`;

/** The difference of the middles of the paired runs (the same task and repeat in both arms) and the lowest and highest of the pairs. */
function spread(pairs: number[], digits: number): string {
  if (!pairs.length) return "-";
  return `${signed(median(pairs), digits)} (${signed(Math.min(...pairs), digits)} to ${signed(Math.max(...pairs), digits)})`;
}

const at = (runs: readonly AbRun[], task: string, arm: string, repeat: number): AbRun | undefined => runs.find((r) => r.task === task && r.arm === arm && r.repeat === repeat);

/** For each repeat, what `of` gives for `arm` and for `other`, summed over `tasks` (only repeats in which every task ran in both arms): the two lists are paired. */
function pairsOf(runs: readonly AbRun[], tasks: string[], arm: string, other: string, of: (r: AbRun) => number): { a: number[]; b: number[] } {
  const out = { a: [] as number[], b: [] as number[] };
  for (const repeat of [...new Set(runs.map((r) => r.repeat))].sort((x, y) => x - y)) {
    const a = tasks.map((t) => at(runs, t, arm, repeat)), b = tasks.map((t) => at(runs, t, other, repeat));
    if (a.some((r) => !r) || b.some((r) => !r)) continue;
    out.a.push(a.reduce((n, r) => n + of(r!), 0));
    out.b.push(b.reduce((n, r) => n + of(r!), 0));
  }
  return out;
}

/** A table for every arm after the first, set against the first: per task and in total, the passes of each arm and the middle of each measure with the difference and its spread. */
export function summarizeAb(runs: readonly AbRun[], arms: readonly string[]): string {
  const tasks = [...new Set(runs.map((r) => r.task))].sort();
  const lines: string[] = [];
  const first = arms[0]!;
  for (const arm of arms.slice(1)) {
    lines.push(`## ${arm} against ${first}`, "", `| task | passed ${first} | passed ${arm} |${METRICS.map((m) => ` ${m.name} ${first} | ${m.name} ${arm} | difference |`).join("")}`, `|---|---|---|${METRICS.map(() => "---|---|---|").join("")}`);
    const row = (label: string, on: string[]): void => {
      const mine = runs.filter((r) => on.includes(r.task) && r.arm === first), theirs = runs.filter((r) => on.includes(r.task) && r.arm === arm);
      const cells = METRICS.map((m) => {
        const p = pairsOf(runs, on, first, arm, m.of);
        return ` ${p.a.length ? num(median(p.a), m.digits) : "-"} | ${p.b.length ? num(median(p.b), m.digits) : "-"} | ${spread(p.b.map((x, i) => x - p.a[i]!), m.digits)} |`;
      });
      lines.push(`| ${label} | ${rate(mine.filter((r) => r.passed).length, mine.length)} | ${rate(theirs.filter((r) => r.passed).length, theirs.length)} |${cells.join("")}`);
    };
    for (const t of tasks) row(t, [t]);
    row(`all ${tasks.length} tasks (a repeat is the sum of its tasks)`, tasks);
    const scripts = runs.filter((r) => r.arm === arm).map((r) => r.tools?.ExecuteCode ?? 0);
    lines.push("", `Scripts run in ${arm}: ${scripts.reduce((a, b) => a + b, 0)} in ${scripts.length} runs, ${median(runs.filter((r) => r.arm === arm).map((r) => r.nestedCalls ?? 0))} tool calls from inside scripts in the middle run.`, "");
  }
  const failed = runs.filter((r) => !r.passed);
  if (failed.length) lines.push("Runs that did not pass:", ...failed.map((r) => `  ${r.task} ${r.arm} repeat ${r.repeat + 1}: ${r.reason}${r.error ? ` (${r.error})` : ""}`), "");
  lines.push("The middle of a measure is of the repeats; a difference is the later arm minus the first for the same repeat, with the lowest and the highest of those pairs. Few repeats tell little: read the spread, not only the middle.");
  return lines.join("\n");
}
