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

* `task.json` — `id`, `title`, `prompt` (exactly what the agent is told), `check` (a shell command; exit 0 means solved),
  `protect` (globs the agent must not change, normally the tests), `maxSteps`, `timeoutSeconds`.
* `repo/` — the starting files. They are copied into a fresh git repository for every run.
* `solution/` — a reference solution, overlaid on `repo/` to prove the task can be solved.

`validate` checks every task: it must **fail** untouched, **pass** with its solution, and the solution must leave the
protected files alone. A task that passes without any change, or cannot be solved, is rejected before it can skew a result.

## What is measured

Per run: solved or not, and why not (`check failed`, `protected files changed`, `timeout`, `agent failed`), wall time,
model calls, tool calls, output tokens and peak context. A run that makes the tests pass by rewriting them does not count.
`report` summarises per model (pass rate and averages) and per task.

Runs are sequential, so timings are not distorted by parallel load. The agent is started as a separate process
(`navvied run … --json`), so what is measured is the program you ship.
