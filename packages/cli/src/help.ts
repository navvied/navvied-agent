import pkg from "../package.json" with { type: "json" };

export const VERSION: string = pkg.version;

export const HELP = `navvied ${VERSION} — a coding agent for your terminal

Usage
  navvied                        interactive session
  navvied run "<task>"           do one task, print the result, exit
  navvied serve --stdio          run as a protocol server on stdin/stdout
  navvied serve --http           serve the agent over a WebSocket (--port, --host; --web <folder> replaces the built-in web UI;
                                 --ready-line for a program that starts this one; --exit-when-stdin-closes)
  navvied web                    open the web page, already connected to the agent on this computer (--site <address>)
  navvied init                   set up a model (finds local servers for you)
  navvied models                 list configured models
  navvied doctor                 check that everything is in order
  navvied update [version]       update this program
  navvied checkpoints --session <id>          list a session's checkpoints
  navvied restore <checkpoint> --session <id> restore the code (preview; add --yes to apply)

Options
  -m, --model <name>             model from the configuration file
      --mode <ask|edits|plan|auto|bypass>  ask asks before each change, edits lets file edits through, plan researches and proposes, auto acts freely but still asks about what cannot be undone (the default), bypass asks nothing
      --effort <level>           reasoning effort: minimal, low, medium, high, xhigh, max
      --cwd <dir>                working directory (default: current)
      --session <id>             continue a saved session
      --max-steps <n>            model calls allowed per turn (default 60)
      --config <file>            configuration file (default: ~/.config/navvied/config.json, on Windows %APPDATA%\\navvied\\config.json)
      --thinking                 show the model's reasoning text
      --json                     run: print protocol events as JSON lines
  -y, --yes                      run: allow tool calls that ask for approval
      --no-color                 plain output
  -h, --help                     this help
  -v, --version                  print the version

Exit codes   0 ok · 1 the task failed · 2 usage or configuration error · 130 cancelled

Configuration   ~/.config/navvied/config.json (Windows: %APPDATA%\\navvied\\config.json), or set NAVVIED_BASE_URL and NAVVIED_MODEL (and NAVVIED_API_KEY).
`;
