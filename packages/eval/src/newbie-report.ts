import { TOOL_ROWS } from "../../cli/src/tool-table.ts";
import type { Job, LaneResult } from "./newbie.ts";
import { LANE_TOOLS } from "./newbie-prompts.ts";
import { rate } from "./stats.ts";

const solved = (rs: readonly LaneResult[]): number => rs.filter((r) => r.verdict.flags.includes("solved")).length;
const count = (rs: readonly LaneResult[], flag: "wrong-tool" | "no-tool"): number => rs.filter((r) => r.verdict.flags.includes(flag)).length;

/**
 * One row for each tool of the Tools list: how its plain tasks went, how its newbie prompts went, and whether it is robust. A tool is
 * robust only when it passes both: every plain task and every newbie prompt solved, with the right tool.
 */
export function laneTable(all: readonly LaneResult[]): string {
  const results = all.filter((r) => r.reason !== "skipped");
  const lines = ["| tool | plain tasks | newbie prompts | used the tool | wrong tool | no tool | robust |", "|---|---|---|---|---|---|---|"];
  for (const row of TOOL_ROWS) {
    const mine = results.filter((r) => r.tag.tool === row.id);
    const neat = mine.filter((r) => r.tag.lane === "neat"), newbie = mine.filter((r) => r.tag.lane === "newbie");
    if (!mine.length) { lines.push(`| ${row.title} | - | - | - | - | - | not run |`); continue; }
    const robust = LANE_TOOLS[row.id]?.proof ?? (!newbie.length || !neat.length ? "not measured" : solved(neat) === neat.length && solved(newbie) === newbie.length ? "yes" : "no");
    lines.push(`| ${row.title} | ${neat.length ? `${solved(neat)}/${neat.length}` : "-"} | ${newbie.length ? `${solved(newbie)}/${newbie.length}` : "-"} | ${newbie.length ? `${newbie.filter((r) => r.verdict.rightTool).length}/${newbie.length}` : "-"} | ${count(newbie, "wrong-tool")} | ${count(newbie, "no-tool")} | ${robust} |`);
  }
  const newbie = results.filter((r) => r.tag.lane === "newbie");
  const styles = [...new Set(newbie.flatMap((r) => r.tag.styles ?? []))].sort();
  if (styles.length) {
    lines.push("", "| way of asking | solved |", "|---|---|");
    for (const s of styles) { const rs = newbie.filter((r) => r.tag.styles?.includes(s)); lines.push(`| ${s} | ${rate(solved(rs), rs.length)} |`); }
  }
  const failed = newbie.filter((r) => !r.verdict.flags.includes("solved"));
  if (failed.length) {
    lines.push("", "| prompt | flags | what happened |", "|---|---|---|");
    for (const r of failed) lines.push(`| ${r.tag.prompt} | ${r.verdict.flags.join(", ") || (r.verdict.outcome ? "told nothing" : "check failed")} | ${r.passed ? "the task's check held" : r.reason}; tools: ${Object.keys(r.tools ?? {}).join(", ") || "none"} |`);
  }
  return lines.join("\n");
}

/** Model calls a run is assumed to take, by tool, for a plain request; a messy one adds `MESSY`, each follow-up message `FOLLOW_UP`, an earlier conversation `EARLIER`. */
export const CALLS: Readonly<Record<string, number>> = {
  files: 8, terminal: 10, code: 8, "web-search": 8, "web-fetch": 8, browser: 14, ask: 5, todo: 6, helpers: 6, schedule: 5, memory: 6, "session-search": 6, skills: 5, vision: 5,
  "speech-to-text": 4, "text-to-speech": 4, image: 4, "video-generation": 3, "video-analysis": 4, "computer-use": 3,
};
const MESSY = 2, FOLLOW_UP = 3, EARLIER = 2;
/** What each step adds to the conversation (the call and what came back), by tool: the web and the browser send pages back. */
const ADDED: Readonly<Record<string, number>> = { "web-search": 1000, "web-fetch": 1500, browser: 1200, terminal: 600, code: 600 };
const ADDED_DEFAULT = 450;
const CALL_TOKENS = 70;

export interface Estimate { jobs: number; calls: number; tokens: number }

/** What one repeat of these runs is expected to cost, from the size of the first request of each task (measured, `first` in tokens) and the assumed shape of a run. */
export function estimateLane(jobs: readonly Job[], first: Readonly<Record<string, number>>): { total: Estimate; byTool: Record<string, Estimate> } {
  const byTool: Record<string, Estimate> = {};
  for (const j of jobs) {
    const turns = 1 + (j.task.then?.length ?? 0);
    const calls = (CALLS[j.tag.tool] ?? 6) + (j.tag.lane === "newbie" ? MESSY : 0) + (turns - 1) * FOLLOW_UP + (j.task.earlier?.length ?? 0) * EARLIER;
    const start = first[j.task.id] ?? 0, added = ADDED[j.tag.tool] ?? ADDED_DEFAULT;
    const tokens = Math.round(calls * start + (added * calls * (calls - 1)) / 2 + calls * CALL_TOKENS);
    const e = (byTool[j.tag.tool] ??= { jobs: 0, calls: 0, tokens: 0 });
    e.jobs += 1; e.calls += calls; e.tokens += tokens;
  }
  const total = Object.values(byTool).reduce((t, e) => ({ jobs: t.jobs + e.jobs, calls: t.calls + e.calls, tokens: t.tokens + e.tokens }), { jobs: 0, calls: 0, tokens: 0 });
  return { total, byTool };
}

export function estimateTable(e: ReturnType<typeof estimateLane>, repeat: number): string {
  const lines = ["| tool | runs | model calls | tokens |", "|---|---|---|---|"];
  for (const row of TOOL_ROWS) { const t = e.byTool[row.id]; if (t) lines.push(`| ${row.title} | ${t.jobs * repeat} | ${t.calls * repeat} | ${(t.tokens * repeat).toLocaleString("en-US")} |`); }
  lines.push("", `${e.total.jobs * repeat} runs, ${e.total.calls * repeat} model calls, about ${(e.total.tokens * repeat).toLocaleString("en-US")} tokens (${repeat} ${repeat === 1 ? "repeat" : "repeats"}).`);
  return lines.join("\n");
}
