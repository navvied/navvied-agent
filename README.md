# navvied-agent

The AI coding agent that runs anywhere and answers from everywhere. Light enough for small local models, strong enough for any
frontier one. Install it once, then use your machine from [navvied.com](https://navvied.com).

## What it does

navvied reads, writes and edits your code, searches it, runs commands and tests, fetches the web and keeps a task list, the way
a careful developer would. You choose the model:

| Model | How |
|---|---|
| A model on your own machine | navvied finds the model servers already running and offers them |
| A hosted API | an address and a key |
| An agent program you are signed in to | navvied uses its sign-in; your subscription stays with that program |
| The models navvied hosts | `/login`, free for now |

Every model gets the same tools, rules, memory and checkpoints, because the work is done by navvied's own engine.

## Install

**macOS and Linux**

```
curl -fsSL https://github.com/navvied/navvied-agent/releases/latest/download/install.sh | sh
navvied
```

**Windows** (PowerShell)

```
irm https://github.com/navvied/navvied-agent/releases/latest/download/install.ps1 | iex
navvied
```

**Desktop app** for macOS, Windows and Linux: download it from the
[latest release](https://github.com/navvied/navvied-agent/releases/latest).

The first run sets up a model with you. Everything is a menu: move with ↑ ↓, press Enter.

## Use it from anywhere

Connect your computer once and open [navvied.com](https://navvied.com) on any device: the conversation runs on your machine,
with your files and your model, and follows you from the terminal to the browser and back.
Not installed yet? Try it at navvied.com without signing in.

## You stay in control

| Mode | What the agent may do |
|---|---|
| Ask first | asks before every change |
| Edits | changes files, asks before running commands |
| Plan only | reads and researches, then proposes a plan you approve |
| Auto | acts freely, asks only before what cannot be undone |
| Bypass | never asks |

Before each message navvied saves a checkpoint, so you can roll your code back to any point. `NAVVIED.md` in a project holds
your standing instructions.

## Documents

| Document | About |
|---|---|
| [docs/INSTALL.md](docs/INSTALL.md) | installers, Docker, updates |
| [docs/CLI.md](docs/CLI.md) | the `navvied` command, models, skills, hooks, memory |
| [docs/DESKTOP.md](docs/DESKTOP.md) | the desktop app |
| [docs/PROTOCOL.md](docs/PROTOCOL.md) | the event protocol every front-end speaks |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | how the pieces fit |
| [docs/EVAL.md](docs/EVAL.md) | measuring an agent on real coding tasks |

## Build from source

```
bun install
bun run typecheck
bun test packages
bun build --compile packages/cli/src/main.ts --outfile navvied
```

## License

navvied is **source-available**: you may use, study and modify it for any noncommercial purpose under the
[PolyForm Noncommercial License 1.0.0](LICENSE). Commercial use needs a separate written license from the copyright holder.
