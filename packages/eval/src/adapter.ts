import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix, win32 } from "node:path";

/**
 * Another agent, described as data. The file is the person's own and lives outside this repository (see docs/EVAL.md): the
 * repository carries this reader and an example, never a description of a particular product. Nothing in it is run except the
 * `argv` and `version` commands the person wrote.
 */
export interface Adapter {
  /** What the results call this agent. */
  label: string;
  /** How it is started on one task. `{prompt}`, `{dir}`, `{model}`, `{base_url}` and `{key}` are filled in. */
  argv: string[];
  env: Record<string, string>;
  /** How to ask it for its version, and where it is installed (for its size on disk). */
  version?: string[];
  install?: string;
  /** Whether `{base_url}` is in `argv` or `env`: such an agent can be counted by the counter; any other reports on its own or not at all. */
  pointable: boolean;
}

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string");

export function parseAdapter(raw: unknown, where = "the agent file"): Adapter {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  if (typeof r.label !== "string" || !/^[\w.-]+$/.test(r.label)) throw new Error(`${where}: "label" is needed: letters, digits, dots, dashes`);
  if (!isStrings(r.argv)) throw new Error(`${where}: "argv" is needed: the command and its arguments, as a list of text`);
  if (!r.argv.some((a) => a.includes("{prompt}"))) throw new Error(`${where}: "argv" must hold {prompt}, where the task goes`);
  const env = r.env ?? {};
  if (typeof env !== "object" || env === null || Object.values(env).some((v) => typeof v !== "string")) throw new Error(`${where}: "env" is a list of names and text`);
  if (r.version !== undefined && !isStrings(r.version)) throw new Error(`${where}: "version" is a command, as a list of text`);
  if (r.install !== undefined && typeof r.install !== "string") throw new Error(`${where}: "install" is a path`);
  const environment = env as Record<string, string>;
  return {
    label: r.label, argv: r.argv, env: environment,
    ...(r.version ? { version: r.version as string[] } : {}),
    ...(typeof r.install === "string" ? { install: r.install } : {}),
    pointable: r.argv.some((a) => a.includes("{base_url}")) || Object.values(environment).some((v) => v.includes("{base_url}")),
  };
}

export const loadAdapter = (file: string): Adapter => parseAdapter(JSON.parse(readFileSync(file, "utf8")), file);

/** Where a person keeps the files of the agents to compare with. */
export function agentsDir(env: Record<string, string | undefined>, platform: NodeJS.Platform = process.platform): string {
  if (env.NAVVIED_BENCH_AGENTS) return env.NAVVIED_BENCH_AGENTS;
  const joined = platform === "win32" ? win32.join : posix.join;
  const config = platform === "win32" ? env.APPDATA ?? joined(homedir(), "AppData", "Roaming") : env.XDG_CONFIG_HOME ?? joined(env.HOME ?? homedir(), ".config");
  return joined(config, "navvied", "bench", "agents");
}

/** Every agent file in the folder, by label. */
export function listAdapters(dir: string): Adapter[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => loadAdapter(join(dir, f)));
}

const fill = (text: string, values: Record<string, string>): string => text.replace(/\{(prompt|dir|model|base_url|key)\}/g, (_, k: string) => values[k] ?? "");

/** The command and the environment for one task. */
export function instantiate(a: Adapter, values: { prompt: string; dir: string; model?: string; baseUrl?: string; key?: string }): { argv: string[]; env: Record<string, string> } {
  const v = { prompt: values.prompt, dir: values.dir, model: values.model ?? "", base_url: values.baseUrl ?? "", key: values.key ?? "" };
  return { argv: a.argv.map((x) => fill(x, v)), env: Object.fromEntries(Object.entries(a.env).map(([k, x]) => [k, fill(x, v)])) };
}
