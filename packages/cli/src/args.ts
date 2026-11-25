import { EFFORTS, PERM_MODES, SESSION_KINDS, type Effort, type PermMode, type SessionKind } from "@navvied/protocol";

export type CommandName = "run" | "chat" | "serve" | "web" | "models" | "checkpoints" | "restore" | "init" | "update" | "doctor" | "help" | "version" | "guard" | "schedule" | "acp";
const COMMANDS: readonly CommandName[] = ["run", "chat", "serve", "web", "models", "checkpoints", "restore", "init", "update", "doctor", "help", "version", "guard", "schedule", "acp"];

export interface Options {
  mode?: PermMode;
  model?: string;
  effort?: Effort;
  cwd?: string;
  session?: string;
  /** What the conversation is for (default `agent`). A `chat` works in a scratch folder of its own. */
  kind?: SessionKind;
  /** Open Providers as soon as the app is up (`navvied init`). */
  providers?: boolean;
  /** The program runs inside a sandbox (a hosted session), so a chat may run commands too. */
  sandboxed?: boolean;
  /** `run`: print every protocol event as a JSON line instead of readable text. */
  json: boolean;
  /** `run`: a JSON Schema file; the answer must be JSON that matches it, and only that is printed. */
  schema?: string;
  /** `run`: scripted answers to the agent's questions, in the order they are asked: one entry per question, a word or a list of words. Without them nobody can answer in a run. */
  answers?: string[][];
  /** `run`: print only the final answer, not the steps. */
  last?: boolean;
  /** `run`: allow every tool call that asks for approval. `restore`: apply the restore instead of only previewing it. */
  yes: boolean;
  thinking: boolean;
  maxSteps?: number;
  config?: string;
  color?: boolean;
  /** `serve`: listen on a WebSocket instead of standard input/output. */
  http?: boolean;
  port?: number;
  host?: string;
  /** `serve --http`: a built front-end to serve at `/`. */
  web?: string;
  /** `serve --http`: other sites whose pages may connect to this server (the page must still present the token). */
  allowOrigins?: string[];
  /** `web`: the website to open (default https://navvied.com). */
  site?: string;
  /** `serve --http`: print one line, `navvied-ready {"port":N}`, once listening, and nothing that holds the key. For a program that starts this one. */
  readyLine?: boolean;
  /** `serve --http`: stop when standard input closes, so this program ends with the one that started it. */
  exitWhenStdinCloses?: boolean;
}

export type ParseResult =
  | { ok: true; command: CommandName; prompt: string | undefined; options: Options }
  | { ok: false; error: string };

const fail = (error: string): ParseResult => ({ ok: false, error });

const VALUE_FLAGS = new Set(["mode", "model", "effort", "cwd", "session", "schema", "answers", "max-steps", "config", "port", "host", "web", "allow-origin", "site", "kind"]);
const BOOLEAN_FLAGS = new Set(["last", "json", "yes", "thinking", "no-color", "color", "stdio", "http", "help", "version", "ready-line", "exit-when-stdin-closes", "sandboxed"]);
const SHORT: Record<string, string> = { h: "help", v: "version", m: "model", y: "yes" };

export function parseArgs(argv: readonly string[]): ParseResult {
  const options: Options = { json: false, yes: false, thinking: false };
  const positional: string[] = [];
  let command: CommandName | undefined;
  let help = false, version = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--") { positional.push(...argv.slice(i + 1)); break; }
    if (!arg.startsWith("-") || arg === "-") {
      if (!command && positional.length === 0 && (COMMANDS as readonly string[]).includes(arg)) command = arg as CommandName;
      else positional.push(arg);
      continue;
    }

    let name = arg.replace(/^--?/, ""), inline: string | undefined;
    const eq = name.indexOf("=");
    if (eq >= 0) { inline = name.slice(eq + 1); name = name.slice(0, eq); }
    if (!arg.startsWith("--")) { const long = SHORT[name]; if (!long) return fail(`unknown option "${arg}"`); name = long; }

    if (BOOLEAN_FLAGS.has(name)) {
      if (inline !== undefined) return fail(`option --${name} does not take a value`);
      switch (name) {
        case "json": options.json = true; break;
        case "last": options.last = true; break;
        case "yes": options.yes = true; break;
        case "thinking": options.thinking = true; break;
        case "no-color": options.color = false; break;
        case "color": options.color = true; break;
        case "help": help = true; break;
        case "version": version = true; break;
        case "ready-line": options.readyLine = true; break;
        case "exit-when-stdin-closes": options.exitWhenStdinCloses = true; break;
        case "http": options.http = true; break;
        case "sandboxed": options.sandboxed = true; break;
        case "stdio": break; // accepted for `serve --stdio`, which is the default transport
        case "http": options.http = true; break;
      }
      continue;
    }
    if (!VALUE_FLAGS.has(name)) return fail(`unknown option "--${name}"`);
    const value = inline ?? argv[++i];
    if (value === undefined || (inline === undefined && value.startsWith("--"))) return fail(`option --${name} needs a value`);

    switch (name) {
      case "mode":
        if (!PERM_MODES.includes(value as PermMode)) return fail(`--mode must be one of ${PERM_MODES.join(", ")}`);
        options.mode = value as PermMode; break;
      case "effort":
        if (!EFFORTS.includes(value as Effort)) return fail(`--effort must be one of ${EFFORTS.join(", ")}`);
        options.effort = value as Effort; break;
      case "max-steps": {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1) return fail("--max-steps must be a positive whole number");
        options.maxSteps = n; break;
      }
      case "model": options.model = value; break;
      case "kind":
        if (!SESSION_KINDS.includes(value as SessionKind)) return fail(`--kind must be one of ${SESSION_KINDS.join(", ")}`);
        options.kind = value as SessionKind; break;
      case "cwd": options.cwd = value; break;
      case "session": options.session = value; break;
      case "schema": options.schema = value; break;
      case "answers": {
        let list: unknown;
        try { list = JSON.parse(value); } catch { list = undefined; }
        if (!Array.isArray(list) || list.some((a) => typeof a !== "string" && !(Array.isArray(a) && a.every((x) => typeof x === "string")))) return fail('--answers must be a JSON list of answers, each a word or a list of words, such as ["Postgres", ["a", "b"]]');
        options.answers = list.map((a) => (Array.isArray(a) ? a as string[] : [a as string])); break;
      }
      case "config": options.config = value; break;
      case "port": {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 0 || n > 65535) return fail("--port must be a whole number from 0 to 65535");
        options.port = n; break;
      }
      case "host": options.host = value; break;
      case "web": options.web = value; break;
      case "site": options.site = value; break;
      case "allow-origin": options.allowOrigins = [...(options.allowOrigins ?? []), value]; break;
    }
  }

  if (help) return { ok: true, command: "help", prompt: undefined, options };
  if (version) return { ok: true, command: "version", prompt: undefined, options };
  if (!command) {
    if (positional.length) return fail(`unknown command "${positional[0]}" (try: navvied --help)`);
    command = "chat";
  }
  const text = positional.join(" ").trim();
  if (command !== "run" && command !== "schedule" && command !== "chat" && command !== "restore" && command !== "update" && text) return fail(`"${command}" does not take arguments`);
  return { ok: true, command, prompt: text || undefined, options };
}
