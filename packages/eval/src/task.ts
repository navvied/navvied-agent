import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export const KINDS = ["fix", "feature", "refactor", "tests", "docs", "terminal", "web", "agent"] as const;
export const LANGS = ["ts", "py", "sh", "c", "none"] as const;

export interface Task {
  id: string;
  title: string;
  kind: (typeof KINDS)[number];
  /** 1 easy, 2 medium, 3 hard. */
  level: 1 | 2 | 3;
  lang: (typeof LANGS)[number];
  /** Programs the task needs; on a computer without one the task is skipped, never failed. */
  requires: string[];
  /** Shell commands run in the workspace before the agent starts and after the check; both see BENCH_SECRET. */
  setup?: string;
  teardown?: string;
  /** Added to the environment of the agent. `{port}` is the port the setup left in `.bench-port`, for the tasks that start a fixture web. */
  env?: Record<string, string>;
  /** MCP servers the agent is given for this task: each is a program of the fixtures folder (`fixture`), started by the agent itself from its own configuration, which the harness writes for the run. */
  mcp?: Record<string, { fixture: string }>;
  /** Takes minutes: run only when asked for. */
  slow: boolean;
  prompt: string;
  /** What the person answers when the agent asks a question, in the order the questions come (given to the agent as `--answers`). */
  answers?: string[];
  /** The task is done by keeping a task list: every list the agent sent has one item in progress at most, and the last has all of them completed. */
  plan?: boolean;
  /** What the scripted model does besides the solution's actions: the questions it asks, the helpers it hands research to (`says` is what the helper answers), the task list it keeps. A real model decides these itself. */
  oracle?: { ask?: { question: string; choices?: string[] }[]; helpers?: { prompt: string; says: string }[]; plan?: string[] };
  /** Shell command run in the finished workspace; exit code 0 means the task is solved. */
  check: string;
  /** Files (globs) the agent must not change, such as the tests. */
  protect: string[];
  maxSteps: number;
  timeoutSeconds: number;
  /** The calls the scripted `oracle` model makes, in place of laying down the solution's files: for a task that is about how a tool behaves. */
  script?: ScriptedCall[];
  dir: string;
}

/** One call of the scripted model. In a text argument `${result:RE}` is the first group of RE found in the last tool result, and `${picture}` is the text of the last picture the model was shown. */
export interface ScriptedCall { tool: string; args: Record<string, unknown> }

const isString = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isMcp = (v: unknown): v is NonNullable<Task["mcp"]> => !!v && typeof v === "object" && !Array.isArray(v) && Object.values(v).every((e) => !!e && typeof e === "object" && isString((e as { fixture?: unknown }).fixture));

export function loadTask(dir: string): Task {
  const raw = JSON.parse(readFileSync(join(dir, "task.json"), "utf8")) as Record<string, unknown>;
  if (!isString(raw.id) || !isString(raw.title) || !isString(raw.prompt) || !isString(raw.check)) throw new Error(`${dir}/task.json: id, title, prompt and check are required`);
  if (!existsSync(join(dir, "repo")) || !existsSync(join(dir, "solution"))) throw new Error(`${dir}: repo/ and solution/ are required`);
  const kind = (KINDS as readonly unknown[]).includes(raw.kind) ? (raw.kind as Task["kind"]) : undefined;
  const lang = (LANGS as readonly unknown[]).includes(raw.lang) ? (raw.lang as Task["lang"]) : undefined;
  if (!kind || !lang || (raw.level !== 1 && raw.level !== 2 && raw.level !== 3)) throw new Error(`${dir}/task.json: kind (${KINDS.join(", ")}), level (1, 2 or 3) and lang (${LANGS.join(", ")}) are required`);
  const protect = Array.isArray(raw.protect) ? raw.protect.filter(isString) : [];
  const script = existsSync(join(dir, "oracle.json")) ? (JSON.parse(readFileSync(join(dir, "oracle.json"), "utf8")) as ScriptedCall[]) : undefined;
  if (script && !(Array.isArray(script) && script.every((c) => isString(c.tool) && typeof c.args === "object" && c.args !== null))) throw new Error(`${dir}/oracle.json: a list of {"tool", "args"} is required`);
  return {
    id: raw.id, title: raw.title, kind, level: raw.level, lang, prompt: raw.prompt, check: raw.check, protect, dir,
    requires: Array.isArray(raw.requires) ? raw.requires.filter(isString) : [],
    ...(isString(raw.setup) ? { setup: raw.setup } : {}),
    ...(isString(raw.teardown) ? { teardown: raw.teardown } : {}),
    ...(raw.env && typeof raw.env === "object" && !Array.isArray(raw.env) ? { env: Object.fromEntries(Object.entries(raw.env as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string")) } : {}),
    ...(isMcp(raw.mcp) ? { mcp: raw.mcp } : {}),
    ...(script ? { script } : {}),
    slow: raw.slow === true,
    ...(Array.isArray(raw.answers) ? { answers: raw.answers.filter(isString) } : {}),
    ...(raw.plan === true ? { plan: true } : {}),
    ...(raw.oracle && typeof raw.oracle === "object" ? { oracle: raw.oracle as NonNullable<Task["oracle"]> } : {}),
    maxSteps: typeof raw.maxSteps === "number" ? raw.maxSteps : 30,
    timeoutSeconds: typeof raw.timeoutSeconds === "number" ? raw.timeoutSeconds : 300,
  };
}

export function loadTasks(root: string, only?: readonly string[]): Task[] {
  const all = readdirSync(root).sort().map((name) => join(root, name)).filter((p) => statSync(p).isDirectory() && existsSync(join(p, "task.json"))).map(loadTask);
  const ids = new Set(all.map((t) => t.id));
  if (ids.size !== all.length) throw new Error("task ids must be unique");
  const missing = (only ?? []).filter((id) => !ids.has(id));
  if (missing.length) throw new Error(`unknown task: ${missing.join(", ")}`);
  return only?.length ? all.filter((t) => only.includes(t.id)) : all;
}

export function filesOf(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p); else out[relative(dir, p).replace(/\\/g, "/")] = readFileSync(p, "utf8");
    }
  };
  walk(dir);
  return out;
}

export const repoFiles = (task: Task): Record<string, string> => filesOf(join(task.dir, "repo"));
/** The reference solution written as a script for the code tool (`code.py`, with the stubs of `navvied_tools`): it is not laid over the workspace, the scripted model sends it. */
export const SOLUTION_SCRIPT = "code.py";
const solutionFilesOf = (task: Task): Record<string, string> => { const files = filesOf(join(task.dir, "solution")); delete files[SOLUTION_SCRIPT]; return files; };
export const solutionScript = (task: Task): string | undefined => { try { return readFileSync(join(task.dir, "solution", SOLUTION_SCRIPT), "utf8"); } catch { return undefined; } };
/**
 * The solution's files. A file may hold `{{answer1}}`, `{{answer2}}` (what the person answered) and `{{helper1}}`, `{{helper2}}` (what a
 * helper reported): the validator fills them with the task's own values, the scripted model with what it was really told.
 */
export function solutionFiles(task: Task, values: { answers?: readonly string[]; helpers?: readonly string[] } = {}): Record<string, string> {
  const answers = values.answers ?? task.answers ?? [], helpers = values.helpers ?? task.oracle?.helpers?.map((h) => h.says) ?? [];
  const fill = (text: string): string => text.replace(/\{\{(answer|helper)(\d)\}\}/g, (_, kind: string, n: string) => (kind === "answer" ? answers : helpers)[Number(n) - 1] ?? "(none)");
  return Object.fromEntries(Object.entries(solutionFilesOf(task)).map(([name, text]) => [name, fill(text)]));
}
