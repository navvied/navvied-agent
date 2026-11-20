import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export const KINDS = ["fix", "feature", "refactor", "tests", "docs", "terminal", "web"] as const;
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
  /** Takes minutes: run only when asked for. */
  slow: boolean;
  prompt: string;
  /** Shell command run in the finished workspace; exit code 0 means the task is solved. */
  check: string;
  /** Files (globs) the agent must not change, such as the tests. */
  protect: string[];
  maxSteps: number;
  timeoutSeconds: number;
  dir: string;
}

const isString = (v: unknown): v is string => typeof v === "string" && v.length > 0;

export function loadTask(dir: string): Task {
  const raw = JSON.parse(readFileSync(join(dir, "task.json"), "utf8")) as Record<string, unknown>;
  if (!isString(raw.id) || !isString(raw.title) || !isString(raw.prompt) || !isString(raw.check)) throw new Error(`${dir}/task.json: id, title, prompt and check are required`);
  if (!existsSync(join(dir, "repo")) || !existsSync(join(dir, "solution"))) throw new Error(`${dir}: repo/ and solution/ are required`);
  const kind = (KINDS as readonly unknown[]).includes(raw.kind) ? (raw.kind as Task["kind"]) : undefined;
  const lang = (LANGS as readonly unknown[]).includes(raw.lang) ? (raw.lang as Task["lang"]) : undefined;
  if (!kind || !lang || (raw.level !== 1 && raw.level !== 2 && raw.level !== 3)) throw new Error(`${dir}/task.json: kind (${KINDS.join(", ")}), level (1, 2 or 3) and lang (${LANGS.join(", ")}) are required`);
  const protect = Array.isArray(raw.protect) ? raw.protect.filter(isString) : [];
  return {
    id: raw.id, title: raw.title, kind, level: raw.level, lang, prompt: raw.prompt, check: raw.check, protect, dir,
    requires: Array.isArray(raw.requires) ? raw.requires.filter(isString) : [],
    ...(isString(raw.setup) ? { setup: raw.setup } : {}),
    ...(isString(raw.teardown) ? { teardown: raw.teardown } : {}),
    ...(raw.env && typeof raw.env === "object" && !Array.isArray(raw.env) ? { env: Object.fromEntries(Object.entries(raw.env as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string")) } : {}),
    slow: raw.slow === true,
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
export const solutionFiles = (task: Task): Record<string, string> => filesOf(join(task.dir, "solution"));
