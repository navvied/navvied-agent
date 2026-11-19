import type { TaskResult } from "./run.ts";
import { rate } from "./stats.ts";

const pct = (n: number, d: number): string => `${d ? Math.round((n / d) * 100) : 0}%`;
const avg = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** A Markdown summary: one row per model, then a pass grid per task. */
export function summarize(all: readonly TaskResult[]): string {
  const skipped = all.filter((r) => r.reason === "skipped");
  const results = all.filter((r) => r.reason !== "skipped");
  const models = [...new Set(results.map((r) => r.model))];
  const tasks = [...new Set(results.map((r) => r.task))];
  // Measured by the counter and the memory watcher only when the run had them: the older columns stay as they were.
  const counted = results.some((x) => x.inTokens !== undefined), watched = results.some((x) => x.peakMb !== undefined);
  const lines = [`| model | solved | avg time | avg model calls | avg tool calls | avg output tokens |${counted ? " avg input tokens | first request | tools offered | prompt chars |" : ""}${watched ? " peak memory |" : ""}`, `|---|---|---|---|---|---|${counted ? "---|---|---|---|" : ""}${watched ? "---|" : ""}`];
  for (const model of models) {
    const rs = results.filter((r) => r.model === model);
    const solved = rs.filter((r) => r.passed).length;
    lines.push(`| ${model} | ${solved}/${rs.length} (${pct(solved, rs.length)}) | ${(avg(rs.map((r) => r.ms)) / 1000).toFixed(1)}s | ${avg(rs.map((r) => r.modelCalls)).toFixed(1)} | ${avg(rs.map((r) => r.toolCalls)).toFixed(1)} | ${Math.round(avg(rs.map((r) => r.outTokens)))} |${counted ? ` ${Math.round(avg(rs.map((r) => r.inTokens ?? 0)))}${rs.some((r) => r.estimated) ? "*" : ""} | ${(avg(rs.map((r) => r.firstRequestMs ?? 0)) / 1000).toFixed(1)}s | ${Math.round(avg(rs.map((r) => r.prompt?.tools ?? 0)))} | ${Math.round(avg(rs.map((r) => (r.prompt?.systemChars ?? 0) + (r.prompt?.toolChars ?? 0))))} |` : ""}${watched ? ` ${Math.round(avg(rs.map((r) => r.peakMb ?? 0)))} MB (${Math.round(avg(rs.map((r) => r.peakTreeMb ?? 0)))} with what it started) |` : ""}`);
  }
  if (counted && results.some((x) => x.estimated)) lines.push("", "* some tokens are estimated (characters divided by four): the model's answer did not say.");
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
  // By what the task asks for: where an agent is strong or weak shows here, and the interval says how much a few runs can tell.
  const groups: [string, (r: TaskResult) => string | undefined, string[]][] = [
    ["kind of work", (r) => r.kind, ["fix", "feature", "refactor", "tests", "docs", "terminal"]],
    ["level", (r) => (r.level ? `level ${r.level}` : undefined), ["level 1", "level 2", "level 3"]],
    ["language", (r) => r.lang, ["ts", "py", "sh", "c", "none"]],
  ];
  for (const [title, of, order] of groups) {
    const present = order.filter((g) => results.some((r) => of(r) === g));
    if (!present.length) continue;
    lines.push("", `| ${title} | ${models.join(" | ")} |`, `|---|${models.map(() => "---").join("|")}|`);
    for (const g of present) lines.push(`| ${g} | ${models.map((m) => { const rs = results.filter((r) => r.model === m && of(r) === g); return rs.length ? rate(rs.filter((r) => r.passed).length, rs.length) : "-"; }).join(" | ")} |`);
  }
  if (skipped.length) lines.push("", `Skipped, not counted: ${[...new Set(skipped.map((r) => `${r.task} (${r.error})`))].join(", ")}.`);
  return lines.join("\n");
}
