import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { TOOL_ROWS } from "../../cli/src/tool-table.ts";
import { CANNOT_WORDS, CHECK_OVERRIDES, LANE_TOOLS, MAY_ADD, NEWBIE, UNCHECKED_WORDS, type NewbiePrompt } from "./newbie-prompts.ts";
import type { TaskResult } from "./run.ts";
import { loadTasks, repoFiles, type Task } from "./task.ts";
import { NEWBIE_TASKS, TASKS } from "./world.ts";

/**
 * The newbie lane: the tasks of the other lanes, asked the way a person who has never done it asks. The repository and the check of a
 * task are its own; what changes is the message, and a second check is added: the tool a reasonable agent should end up with.
 */

/** What is known of a run besides the result: which lane, which row of the Tools list, which prompt. */
export interface Tag { lane: "newbie" | "neat"; tool: string; prompt?: string; styles?: readonly string[] }
export interface Job { task: Task; tag: Tag }

export type Flag = "solved" | "wrong-tool" | "no-tool";
export interface Verdict { /** The task's own check held. */ outcome: boolean; /** The tools used include one the lane accepts: reported for every row, a flag only for the rows where the tool is the result. */ rightTool: boolean; flags: Flag[] }
export type LaneResult = TaskResult & { tag: Tag; verdict: Verdict };

export const LANE_ROWS: readonly { id: string; title: string }[] = [...TOOL_ROWS.map(({ id, title }) => ({ id, title })), { id: "no-screen", title: "No screen here" }];

export const laneTasks = (): Task[] => [...loadTasks(TASKS), ...loadTasks(NEWBIE_TASKS)];

/** The tasks the prompts are tied to, each once: what has to be fit to measure with (see validate.ts) for the lane to mean anything. */
export const laneBases = (tasks: readonly Task[] = laneTasks()): Task[] => { const ids = new Set(NEWBIE.map((p) => p.task)); return tasks.filter((t) => ids.has(t.id)); };

/** The names of the files a task wants made at the top of the workspace, found in its solution, its script and its check: not the ones it starts with or makes in its setup. */
export function wantedFiles(base: Task): string[] {
  const texts = [base.check];
  const walk = (dir: string): void => {
    for (const name of existsSync(dir) ? readdirSync(dir) : []) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path); else { texts.push(name); try { texts.push(readFileSync(path, "utf8")); } catch { /* not text */ } }
    }
  };
  walk(join(base.dir, "solution"));
  if (existsSync(join(base.dir, "oracle.json"))) texts.push(readFileSync(join(base.dir, "oracle.json"), "utf8"));
  const known = new Set([...Object.keys(repoFiles(base)), ...(base.setup?.match(NAMES) ?? [])].map((n) => n.toLowerCase()));
  return [...new Set(texts.flatMap((t) => t.match(NAMES) ?? []))].filter((n) => !known.has(n.toLowerCase()));
}
const NAMES = /(?<![\w./-])[A-Za-z0-9_-]+\.(?:txt|json|csv|wav|png|md|mp4)\b/g;

/**
 * A prompt that is written in capitals names its files in capitals ("ANSWER.TXT"). A person who shouts does not mean a file of another
 * name than one who does not: a file that has the wanted name in other letters is copied to the wanted name before the check runs. The
 * check itself is not changed, and a prompt that is not in capitals does not get this.
 */
export const caseFix = (names: readonly string[]): string => names.map((n) => `[ -e '${n}' ] || for f in *; do [ "$(printf %s "$f" | tr A-Z a-z)" = '${n.toLowerCase()}' ] && cp "$f" '${n}'; done`).join("; ");

/** The task with the words of the prompt in place of its own, and the calls the scripted model makes to touch the tool of the lane. */
export function derive(p: NewbiePrompt, base: Task): Task {
  const touch = LANE_TOOLS[p.tool]?.touch;
  const check = CHECK_OVERRIDES[p.id] ?? base.check;
  const names = p.styles.includes("caps") ? wantedFiles(base) : [];
  return { ...base, prompt: p.say, ...(MAY_ADD[p.id] ? { mayAdd: [...MAY_ADD[p.id]!] } : {}), check: names.length ? `${caseFix(names)}; ${check}` : check, ...(p.then ? { then: [...p.then] } : {}), ...(touch ? { touch: touch.map((c) => ({ tool: c.tool, args: { ...c.args } })) } : {}) };
}

export interface Selection { tools?: readonly string[]; /** At most this many prompts of each tool. */ perTool?: number; /** Also the plain task of each tool once, to compare with. */ neat?: boolean }

/** The runs of the lane, the prompts first; with `neat`, the plain tasks the prompts are tied to, once for each tool. */
export function laneJobs(sel: Selection = {}, tasks: readonly Task[] = laneTasks()): Job[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const rows = LANE_ROWS.map((r) => r.id).filter((id) => !sel.tools?.length || sel.tools.includes(id));
  const jobs: Job[] = [], neat: Job[] = [];
  for (const tool of rows) {
    const own = NEWBIE.filter((p) => p.tool === tool).slice(0, sel.perTool ?? Infinity);
    for (const p of own) jobs.push({ task: derive(p, byId.get(p.task)!), tag: { lane: "newbie", tool, prompt: p.id, styles: p.styles } });
    if (sel.neat) for (const id of new Set(own.map((p) => p.task))) neat.push({ task: byId.get(id)!, tag: { lane: "neat", tool } });
  }
  return [...jobs, ...neat];
}

/** The tasks a scripted model is given for these runs: where a task is asked both ways, the prompt's own (the one that touches the tool). */
export const mockTasks = (jobs: readonly Job[]): Task[] => [...new Map([...jobs].sort((a, b) => Number(a.tag.lane === "newbie") - Number(b.tag.lane === "newbie")).map((j) => [j.task.id, j.task])).values()];

const has = (text: string | undefined, words: readonly string[]): boolean => { const t = (text ?? "").toLowerCase(); return words.some((w) => t.includes(w)); };

/**
 * Whether a run did what a reasonable agent does. The outcome decides first: when the task's own check holds, the run passes, whatever
 * tool did the work. The tool counts only where it is the result (`strict`: a saved job, a found conversation, a task list, a question
 * asked, a skill used); there a run that held its check without it is flagged wrong-tool, or no-tool when it used none. Elsewhere the
 * tools used are only reported. Where the thing cannot be done, the answer is what counts: saying so, or asking, and making up nothing;
 * for a video, saying what was not checked is as good.
 */
export function judge(tag: Tag, result: TaskResult): Verdict {
  const lane = LANE_TOOLS[tag.tool]!;
  const used = Object.keys(result.tools ?? {});
  const rightTool = used.some((t) => lane.accept.includes(t));
  const outcome = result.passed;
  if (lane.mode) {
    const told = has(result.said, CANNOT_WORDS) || (result.said ?? "").includes("?");
    return { outcome, rightTool, flags: outcome && (told || (lane.mode === "honest" && has(result.said, UNCHECKED_WORDS))) ? ["solved"] : [] };
  }
  const flags: Flag[] = [];
  if (lane.strict && tag.lane === "newbie" && !rightTool) flags.push(used.length ? "wrong-tool" : "no-tool");
  if (outcome && !flags.length) flags.push("solved");
  return { outcome, rightTool, flags };
}

export const tagged = (tag: Tag, result: TaskResult): LaneResult => ({ ...result, tag, verdict: judge(tag, result) });
