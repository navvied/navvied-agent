import type { TaskResult } from "./run.ts";

const pct = (n: number, d: number): string => `${d ? Math.round((n / d) * 100) : 0}%`;
const avg = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** A Markdown summary: one row per model, then a pass grid per task. */
export function summarize(results: readonly TaskResult[]): string {
  const models = [...new Set(results.map((r) => r.model))];
  const tasks = [...new Set(results.map((r) => r.task))];
  const lines = ["| model | solved | avg time | avg model calls | avg tool calls | avg output tokens |", "|---|---|---|---|---|---|"];
  for (const model of models) {
    const rs = results.filter((r) => r.model === model);
    const solved = rs.filter((r) => r.passed).length;
    lines.push(`| ${model} | ${solved}/${rs.length} (${pct(solved, rs.length)}) | ${(avg(rs.map((r) => r.ms)) / 1000).toFixed(1)}s | ${avg(rs.map((r) => r.modelCalls)).toFixed(1)} | ${avg(rs.map((r) => r.toolCalls)).toFixed(1)} | ${Math.round(avg(rs.map((r) => r.outTokens)))} |`);
  }
  lines.push("", `| task | ${models.join(" | ")} |`, `|---|${models.map(() => "---").join("|")}|`);
  for (const task of tasks) {
    const cells = models.map((model) => {
      const rs = results.filter((r) => r.task === task && r.model === model);
      if (!rs.length) return "-";
      const solved = rs.filter((r) => r.passed).length;
      return rs.length === 1 ? (solved ? "pass" : `fail (${rs[0]!.reason})`) : `${solved}/${rs.length}`;
    });
    lines.push(`| ${task} | ${cells.join(" | ")} |`);
  }
  return lines.join("\n");
}
