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

* `task.json` — `id`, `title`, `kind` (`fix`, `feature`, `refactor`, `tests`, `docs`, `terminal`, `web`, `agent`: work done with the agent's own tools, such as asking, a task list and helpers), `level` (1 easy, 2 medium,
  3 hard), `lang` (`ts`, `py`, `sh`, `c`, `none`), `prompt` (exactly what the agent is told), `check` (a shell command; exit 0
  means solved), `protect` (globs the agent must not change, normally the tests), `maxSteps`, `timeoutSeconds`. Optional:
  `requires` (programs the task needs: a computer without one skips the task, it is never counted as failed), `setup` and
  `teardown` (shell commands run in the workspace before the agent and after the check), `slow` (takes minutes; run with `--slow`).
  `answers` (what the person answers when the agent asks, in order; given to `navvied run` as `--answers`), `plan` (the run must keep a task list: at least one list, one item in progress at a time, the last all completed, else `task list not kept`) and `oracle` (what the scripted model does besides the solution: `ask` the questions it asks, `helpers` it gives research to with what each `says`, the `plan` it keeps). A solution file may hold `{{answer1}}` or `{{helper1}}`: `validate` fills them with the task's own values, the scripted model with what it was really told.
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

## A real model

```
bun packages/eval/src/main.ts run --upstream http://127.0.0.1:4000/v1 --upstream-model raphael \
  --upstream-key-file ~/.config/navvied-bench/raphael.key --upstream-window 64000 --out results.jsonl
```

The key is read from the file into the environment of the agent: never put on a command line, and a result never holds it (it is
cut out of anything the agent or the model said). The counter lets one request at a time reach the model, and the run is one task
after another. After two runs in a row that ended in a server error or a time-out the run stops: that is for a person to look at.
A run that does not solve its task keeps what the agent last said, the steps it took and the end of what the check printed.

## What is kept of a run that failed

The fixtures of many tasks are made from a random `BENCH_SECRET`, one for each run, so a miss can be worked out again only with the
files and that value. When `--trace` or `--out` is given (here and in the comparison of two arms), each run that does not solve its
task is kept in a folder of its own, in `<trace>/failed/`, or in `<out>.failed/` when there is no trace. With neither, nothing is
kept. The result names the folder (`kept`).

| in the folder | what it is |
|---|---|
| `workspace/` | the workspace as the check was given it, taken before the check runs because a check may write in it |
| `check.json` | the task, how the run ended, the check as it was run, and what is not in the copy and why |
| `secret` | the `BENCH_SECRET` of the run (mode 0600): a random value the fixtures are made from, not a credential |

```
bun packages/eval/src/main.ts recheck results.jsonl.failed/<folder>
```

This runs the check again on a copy of `workspace/`, so what was kept stays as it was; it exits 0 when the check passes. As in the
run itself, a check may execute what is in the workspace, so it runs the agent's files.

**No key is kept.** Only the workspace is copied: not the home the agent was given, nor the configuration the harness writes for it.
The key of the run, and the value of every environment variable whose name says it holds a secret (except `BENCH_*`), is replaced by
`[key]` in every copied file. Links are not followed. A packed file (gzip, zip, xz, zstd, bzip2) cannot be searched, so it is left
out; so is a git folder, under any name, when any of its objects holds a key. These are exact matches: a key that something encoded or split is
not recognised, so read a kept folder before you give it to anyone.

**Bounds.** `node_modules`, `.venv` and `__pycache__` are left out, and so is a file over 2 MB; one run keeps at most 20 MB and
2,000 files. Everything left out is listed in `check.json` (the first hundred by name, the rest counted).

A second run of the check is not the first one in two cases: a check that asks a server the task's setup started finds it stopped, and
a file where a value was replaced, or that was left out, is not what the check saw.

## Does the code tool help? (the comparison of two arms)

`ExecuteCode` runs a Python script that calls the other tools as functions. It is experimental: it is offered only when its switch (the `code`
row of the tools, `tool:code` in the agent's own state) is on, so both arms are one program and the same tasks; the harness switches it on for the code arm. Six tasks named `mc-…` need many
tool calls with logic between them (60 JSON files added up by category, 12 pages of an API followed by their links, a call changed in
45 files where it matches, 8 logs triaged, an import cycle found among 30 modules, two folders of 40 config files compared); each has
a reference solution for the ordinary tools (`apply.sh`) and one written for the code tool (`code.py`, run by `--mock code`).

```
bun packages/eval/src/ab.ts --dry                       the scripted model, both arms: the wiring, no token spent
bun packages/eval/src/ab.ts --estimate                  what a real run is expected to cost, no token spent
bun packages/eval/src/ab.ts --upstream <base address> --upstream-model <id> --upstream-key-file <file> \
  --max-tokens <n> --yes-spend [--tasks mc-…,mc-…] [--repeat 3] [--arms base,code] [--out results.jsonl] [--resume] [--per-minute 20]
```

Nothing is sent to a real model without `--yes-spend`, and `--max-tokens` is a hard limit: the counter refuses the request that would
pass it and the run stops (that run is not counted; `--resume` goes on from the results file). The counter also keeps to the service's
rate (`--per-minute`, 20 by default): requests are spaced, and an answer of "too many requests" is waited out and the request sent
again, so the agent never sees it. What the counter waited is taken out of the seconds that are reported. The arms change places with
every repeat. The report gives, per task and in all, the passes of each arm with their interval and, for model calls, tokens, seconds
and tool calls, the middle of each arm and the difference of the paired repeats with its lowest and highest.

## Terminal tasks and how the terminal is misused

Seven of the tasks are about the terminal: finding one line in a 200,000-line log, starting a slow server and waiting until it
answers, a build of about 40 seconds (`BUILD_SECONDS` shortens it for tests), a command that fails twice before it works, an installer
that asks questions on its input, a worker kept running in the background, and a server that will not start because something
holds its port. Each one answers with a value made from this run's `BENCH_SECRET`, so the answer cannot be guessed, and a run that
leaves a program running is not solved.

For our own program a result also says how the terminal tools were misused (`misuse`): calls the tools refused (`badCalls`), waits
that only polled (`polls`: `BashOutput` without `wait` or `until` that found nothing new) and a `cd` put in front of a command
that could have used `cwd` (`cdCalls`). The report shows the average of each per model.

## The newbie lane (messy prompts)

Our tasks are asked neatly. People are not neat: even a complete beginner types a few words, mixes two languages, misspells, leaves out
the punctuation, shouts, asks for the wrong thing, or only says "go on". The newbie lane asks the tasks of the other lanes that way.
`packages/eval/src/newbie-prompts.ts` holds the messages as data: at least five for each of the 20 rows of the Tools list
(`packages/cli/src/tool-table.ts`), 110 in all, in Indonesian, English and blends, written the ways beginners write (slang, typos, capitals, vague asks). The file keeps those words on purpose, so the language test skips it, like the other word files.

Each prompt is tied to a task. The repository and the task's own check are used as they are; only the message changes.

**The outcome decides first.** When the task's own check holds, the run is solved, whatever tool did the work (Bash where the code tool
was expected, the browser where a fetch was, and so on). The tools used are only reported, in the column "used the tool". The tool
counts only where the tool is the result (`strict` in `LANE_TOOLS`), and only there are the flags set:

| row | the tool must have been used because |
|---|---|
| Schedule | a job was saved |
| Session Search | the earlier conversation was found (`Recall`) |
| Task Planning | a multi-part request was tracked in a task list |
| Questions | a request that cannot be done without the person's answer was asked, not guessed |
| Skills | a project skill applies, and it was used (`Skill`) |

| flag | meaning |
|---|---|
| solved | the task's check holds (and, in a strict row, the tool was used) |
| wrong-tool | strict row only: tools were used, none of them the tool (the check may still hold) |
| no-tool | strict row only: the agent made no tool call at all |

A prompt that needs a second message (`then`) is run as one conversation: the agent is started again with `--session` and the same
folder, so "the one from before" has something to point at. A prompt about an earlier conversation (`newbie-recall`) first has a
separate conversation of its own, then asks about it. That earlier message is a question, with no "I prefer", "always", "we use" or
"remember that" in it, so the notes the program keeps by itself do not take its details: only `Recall` can find the ticket number.

**Real engines.** With a real model (`--upstream`) the speech, picture and video tools run on the real engines, not the stand-ins
(`--media stub` keeps the stand-ins, the scripted model always uses them). They are installed once, through the tool's own setup
(`tool.setup`: whisper.cpp, Piper, stable-diffusion.cpp and the small picture model, as pinned in `media-pins.ts`, about 3 GB), into
`~/.cache/navvied-bench/media` (or `NAVVIED_BENCH_MEDIA`), and kept for the next runs; the tasks that use media get that configuration.
Only the processor is used (`CUDA_VISIBLE_DEVICES` is empty). Where an engine cannot be installed the run stops with the reason: it is
never measured without it. The fixtures work with both kinds: the picture of `read-picture-label` is a real PNG with readable text
(`fixtures/make-chart.ts`), `newbie-watch-clip` is a real 3 second clip made from it with ffmpeg, the recording of `media-transcribe-note`
is made with the installed voice when there is one, and the checks of the three speech and picture tasks accept a stand-in's output or a
real recording or picture (a real duration, a real width and height).

**Skills.** A project skill is held back until the person accepts it, and a held skill is not offered to the model. The fixtures
(`"trust": true` in a task) accept the skill of the project in the state of the agent before it starts, by name and text, as a person
says yes once.

**Where nothing can be done** the answer is what counts. Computer Use has no screen here: the right behaviour is to say plainly that it
cannot be done, or to ask, and to make up nothing (`CANNOT_WORDS`, in both languages; the task, in `packages/eval/newbie-tasks/`, is
`idle`: its check holds before the agent starts and must hold after). Video Generation has no generator: a video made with a program
through the terminal (ffmpeg) is fine when the agent says plainly what it did not check (`UNCHECKED_WORDS`), "cannot, here is what I can
do" is as good, and a made-up result is a fail (the check wants a real video file, or none). The result keeps the last 3000 characters of
what the agent said (`said`) for that. Computer Use cannot be judged on a computer without a screen: its row of the table says "proven by the
computer-use CI check, not in this lane" in place of robust or not robust (`proof` in `LANE_TOOLS`).

**What a check may change.** A check changes only where it is stricter than what the person asked, never to make a run pass: a file
name may be in any case when the prompt was written in capitals (the wanted file is copied from the one the agent made, `caseFix`), and
a prompt that gave no format may be answered in a sentence (`CHECK_OVERRIDES`: the six Session Search prompts, one Helpers prompt, and, from round 4, terminal-1, web-search-3, web-fetch-2, todo-4, memory-3, and the plain memory-typo-forget check).
A task may also let a new file into a folder it protects (`mayAdd`, compared without case): the Helpers prompts let in `docs/summary.txt`, and nothing else of `docs/` may change.
`--tools` takes the ids of the Tools list (`code,web-fetch,ask,todo,helpers,session-search`) and a wrong id is an error.
Each such change is recorded next to the prompt that justifies it, with the old check and the new one. A failed
run keeps what the agent wrote (`why.changes`), the addresses it asked the web tool for (`fetched`), and, with `--trace`, a pair of files for
each prompt and not for each task.

A tool is robust only when it passes both: every plain task of the tool and every newbie prompt of the tool solved. The table of the
lane has a row for each tool (plain tasks, prompts, used the tool, wrong-tool, no-tool, robust), then the solved rate by way of asking, then each
prompt that was not solved with the tools it used.

```
bun packages/eval/src/main.ts validate --lane newbie                    the tasks of the lane fail untouched and pass with their solution
bun packages/eval/src/main.ts run --lane newbie --mock oracle --with-neat   the scripted model: every task is solvable, every checker finds its tool
bun packages/eval/src/main.ts run --lane newbie --estimate [--with-neat]     what one repeat is expected to cost, no token spent
bun packages/eval/src/main.ts run --lane newbie --upstream <base address> --upstream-model <id> --upstream-key-file <file> \
  --max-tokens <n> --yes-spend [--with-neat] [--tools a,b] [--per-tool n] [--arms base,code] [--media real|stub] [--repeat n] [--out r.jsonl] [--trace dir]
bun packages/eval/src/main.ts report r.jsonl                            the table of a finished run
```

The scripted model ignores words: it proves the plumbing (each task can be solved, each checker sees the tool it should, a follow-up
and an earlier conversation are carried), not that a model understands a messy message. The code tool is switched on and offered
(the `code` arm) so that the Code Execution row can be measured; `--arms base,code` runs both. A real run is refused without
`--max-tokens` and `--yes-spend`, and the counter stops at the limit. `--tools` and `--per-tool` cut the cost.

What a real run costs (`--estimate`: the first request of each task is measured through the real program with the scripted model, the number of calls and
what each step adds are assumed in `newbie-report.ts`; about 1,800 tokens go out in the first request of a small task). One repeat, one arm:

| selection | runs | model calls | tokens |
|---|---|---|---|
| every prompt | 110 | 963 | about 4.9 million |
| every prompt and the plain task of each tool | 166 | 1,393 | about 7.2 million |
| `--per-tool 2` | 40 | 328 | about 1.6 million |

The browser rows are the most expensive (pages come back into the conversation). Use `--per-tool 2` for a cheap look, `--tools` to look at one tool.
