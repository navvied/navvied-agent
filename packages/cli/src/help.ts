import pkg from "../package.json" with { type: "json" };
import { wrap } from "./tui/wrap.ts";

export const VERSION: string = pkg.version;

const WIDTH = 100;

/** A row of a help table: the left column at `col` (grown to fit a long label), the right column wrapped and hanging under it. */
function row(left: string, desc: string, col: number): string {
  const c = Math.max(col, left.length + 4);
  return wrap(desc, Math.max(20, WIDTH - c)).map((l, i) => (i === 0 ? `  ${left}${" ".repeat(c - 2 - left.length)}${l}` : `${" ".repeat(c)}${l}`)).join("\n");
}

const rows = (list: [string, string][], col: number): string => list.map(([left, desc]) => row(left, desc, col)).join("\n");

const USAGE = rows([
  ["navvied", "interactive session"],
  ['navvied run "<task>"', "do one task, print the result, exit"],
  ["navvied serve --stdio", "run as a protocol server on stdin/stdout"],
  ["navvied serve --http", "serve the agent over a WebSocket. --port and --host set the address, --web <folder> replaces the built-in web page, --ready-line tells a program that starts this one, --exit-when-stdin-closes stops it when that program does."],
  ["navvied web", "open the web page, already connected to the agent on this computer (--site <address>)"],
  ["navvied init", "add a model: opens Providers"],
  ["navvied models", "list configured models"],
  ["navvied doctor", "check that everything is in order"],
  ["navvied update [version]", "update this program"],
], 34) + "\n" + rows([
  ["navvied checkpoints --session <id>", "list a session's checkpoints"],
  ["navvied restore <checkpoint> --session <id>", "restore the code (preview; add --yes to apply)"],
], 38);

const OPTIONS = rows([
  ["-m, --model <name>", "model from the configuration file"],
  ["--mode <ask|edits|plan|auto|bypass>", "ask asks before each change, edits lets file edits through, plan researches and proposes, auto acts freely but still asks about what cannot be undone (the default), bypass asks nothing"],
  ["--effort <level>", "reasoning effort: minimal, low, medium, high, xhigh, max"],
  ["--cwd <dir>", "working directory (default: current)"],
  ["--session <id>", "continue a saved session"],
  ["--max-steps <n>", "model calls allowed per turn (default 60)"],
  ["--config <file>", "configuration file (default: ~/.config/navvied/config.json, on Windows %APPDATA%\\navvied\\config.json)"],
  ["--thinking", "show the model's reasoning text"],
  ["--json", "run: print protocol events as JSON lines"],
  ["-y, --yes", "run: allow tool calls that ask for approval"],
  ["--no-color", "plain output"],
  ["-h, --help", "this help"],
  ["-v, --version", "print the version"],
], 34);

const EXIT_CODES = rows([
  ["0", "ok"],
  ["1", "the task failed"],
  ["2", "usage or configuration error"],
  ["130", "cancelled"],
], 9);

const CONFIGURATION = wrap("~/.config/navvied/config.json (Windows: %APPDATA%\\navvied\\config.json), or set NAVVIED_BASE_URL and NAVVIED_MODEL (and NAVVIED_API_KEY).", WIDTH - 2).map((l) => `  ${l}`).join("\n");

export const HELP = `navvied ${VERSION} — a coding agent for your terminal

Usage
${USAGE}

Options
${OPTIONS}

Exit codes
${EXIT_CODES}

Configuration
${CONFIGURATION}
`;
