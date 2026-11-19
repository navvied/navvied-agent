# Evaluation

`navvied-eval` measures a coding agent on real tasks, so "it works well" is a number and not an impression.

```
bun packages/eval/src/main.ts list
bun packages/eval/src/main.ts validate
bun packages/eval/src/main.ts run --model local --model subscription --repeat 3 --out results.jsonl
bun packages/eval/src/main.ts report results.jsonl
```

Each model name is one from your `config.json` (see [CLI.md](CLI.md)), so the same tasks run against the built-in engine,
a local model, or an external agent program, and the results sit side by side.

## A task

A directory under `packages/eval/tasks/<id>/`:

* `task.json` — `id`, `title`, `kind` (`fix`, `feature`, `refactor`, `tests`, `docs`, `terminal`), `level` (1 easy, 2 medium,
  3 hard), `lang` (`ts`, `py`, `sh`, `c`, `none`), `prompt` (exactly what the agent is told), `check` (a shell command; exit 0
  means solved), `protect` (globs the agent must not change, normally the tests), `maxSteps`, `timeoutSeconds`. Optional:
  `requires` (programs the task needs: a computer without one skips the task, it is never counted as failed), `setup` and
  `teardown` (shell commands run in the workspace before the agent and after the check), `slow` (takes minutes; run with `--slow`).
  `setup`, the agent and `check` all see `BENCH_SECRET`, a value made for each run, so an answer that holds it was made in that run.
* `repo/` — the starting files. They are copied into a fresh git repository for every run.
* `solution/` — a reference solution, overlaid on `repo/` to prove the task can be solved. For a task whose solution is actions
  (start a server, stop a process), `solution/apply.sh` is run after the files are laid down.

`validate` checks every task: it must **fail** untouched, **pass** with its solution, the solution must leave the
protected files alone, and it must leave no process running (on Linux; a run that leaves one is `left a process running`). A task that passes without any change, or cannot be solved, is rejected before it can skew a result.

## What is measured

Per run: solved or not, and why not (`check failed`, `protected files changed`, `timeout`, `agent failed`), wall time,
model calls, tool calls, output tokens and peak context. A run that makes the tests pass by rewriting them does not count.
`report` summarises per model (pass rate and averages) and per task.

Runs are sequential, so timings are not distorted by parallel load. The agent is started as a separate process
(`navvied run … --json`), so what is measured is the program you ship.

## The counter, memory and the scripted model

```
bun packages/eval/src/main.ts run --mock oracle                                   a scripted model, no real model needed
bun packages/eval/src/main.ts run --upstream http://127.0.0.1:11434/v1 --upstream-model qwen --repeat 3
```

With `--mock` or `--upstream` the agent is pointed at a **counter**: a small server in front of the model that passes every request
on and writes down what went through (chat completions and messages are read; anything else is passed on). So calls and tokens are
counted the same way for any agent, and the weight of the prompt is known: characters of the system prompt, tools offered,
characters of their definitions, bytes of the request. Tokens come from the answer's own usage fields; where an answer has none
they are estimated (characters divided by four) and the report marks them with `*`. The report also shows the time to the agent's
first request and the highest memory of the agent and of everything it started (Linux and macOS; not measured on Windows).

`--mock` takes `oracle` (does what the task's reference solution does, through the agent's own tools: it shows a task can be
solved by a real run, not only by the validator), `lazy`, `tamper`, `leave`, `crash` and `hang` (each fails in one known way).

## Other agents, described by a file of yours

```
bun packages/eval/src/main.ts agents                                   the agent files in your folder
bun packages/eval/src/main.ts run --agent <label|file> --upstream <model address> --upstream-model <id> [--upstream-key <key>]
bun packages/eval/src/main.ts footprint --cli "<command>" --install <path>
```

To compare with another agent program, describe it in a JSON file of your own. It is **not** kept in this repository: the folder
is `<config folder>/navvied/bench/agents/` (`NAVVIED_BENCH_AGENTS` to put it elsewhere), and the name of the product is whatever you
write as its `label`. There is no code in the file: only the command to start it on one task.

```json
{
  "label": "example-agent",
  "argv": ["example-agent", "--headless", "--model", "{model}", "{prompt}"],
  "env": { "EXAMPLE_BASE_URL": "{base_url}", "EXAMPLE_API_KEY": "{key}" },
  "version": ["example-agent", "--version"],
  "install": "/usr/local/bin/example-agent"
}
```

`{prompt}`, `{dir}`, `{model}`, `{base_url}` and `{key}` are filled in for each task; the agent is started in the task's workspace. An
agent with `{base_url}` in its command or environment is pointed at the counter, so its calls, tokens and prompt weight are counted
like ours. One without it is still timed, measured for memory and checked; it has no calls to count. What an agent says about itself
is never read.

`footprint` gives the size of the installed program on disk and the time to start it (`--version`) with a home folder that has
never been used: the first start apart from the middle of the rest. Give `--install` for a program found by name; the runtime that
runs source (`bun`, `node`) is not the program and is not measured.

The report gives each pass rate with a 95% interval (a few runs cannot say more than that), by kind of work, level and language.
