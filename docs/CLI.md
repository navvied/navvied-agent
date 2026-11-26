# The `navvied` command

```
navvied                        interactive session; the first run sets up a model
navvied init                   add a model: opens Providers
navvied doctor                 check that everything is in order
navvied update                 update this program now (it also updates itself in the background)
navvied run "<task>"           do one task, print the result, exit
navvied serve --stdio          run as a protocol server on stdin/stdout
navvied serve --http           serve the agent over a WebSocket (see docs/PROTOCOL.md)
navvied models                 list configured models
```

Prefer a window? The desktop app runs the same program with nothing to type: [docs/INSTALL.md](INSTALL.md#the-desktop-app).

## Configuration

`~/.config/navvied/config.json` (override with `--config` or `NAVVIED_CONFIG`):

```json
{
  "default": "local",
  "models": {
    "local":  { "baseUrl": "http://127.0.0.1:11434/v1", "model": "qwen3:32b", "window": 32768, "reasoning": "none" },
    "hosted": { "baseUrl": "https://api.example.com/v1", "model": "large-1", "apiKeyEnv": "EXAMPLE_API_KEY", "window": 200000 }
  }
}
```

* `api` is `"chat"` (the default) or `"messages"`, the kind of HTTP API at `baseUrl`; `navvied` sets it when you pick a service in the setup.
* `baseUrl` is any server that speaks the chat-completions API: a hosted service with an API key, or a local model server.
* Put keys in an environment variable and name it with `apiKeyEnv`. A literal `apiKey` works too; then keep the file private.
* `window` is the context size in tokens. `reasoning: "none"` stops the CLI sending a reasoning-effort field to models that reject it. `small: true` marks a small model (a few billion parameters): it gets few tools and a short prompt. Left out, a model on this computer with a window of 40,000 or less is small and any other is not: the window of a hosted model says nothing about its size.
* `vision: true` or `false` says whether the model can see pictures (left out: not known, so a picture is sent and a refusal is explained in plain words). `pdf: true` says the service reads a PDF given as a file (the messages API of the service that made it), so the original PDF goes along with its text. Files attached to a prompt are described in docs/PROTOCOL.md (Attachments).
* Without a file, set `NAVVIED_BASE_URL` and `NAVVIED_MODEL` (and optionally `NAVVIED_API_KEY`, `NAVVIED_WINDOW`).
* A call to the model that fails because it was busy, asked to slow down, broke, or the connection dropped is made again by itself, up to 7 more times and about two minutes of waiting in all (the service's `Retry-After` is obeyed), and a line says so before each wait. A model server that nobody is listening on is not tried again: it is said at once, with the address ("Nothing answers at http://127.0.0.1:11434. Start the model server, then send again."). `NAVVIED_RETRIES=0` turns it off; any number up to 20 sets how many more tries.

Sessions are saved under `~/.local/state/navvied/sessions`; continue one with `--session <id>`.

## Models, effort and switching

`/model` lists the models of the conversation and the others you connected. Choosing one that navvied runs itself keeps the conversation going: if it is longer than the new model can read, older turns are summarised first, and if even that is not enough the switch is refused and nothing changes. Choosing one of another kind (navvied's own, or a program) hands the conversation over, with what was said so far. A reply that is being written finishes first; nothing is stopped.

`/effort` offers the levels the current model accepts, and Auto. Auto sends no effort at all, so the model's own default applies. Each service gets the effort in its own form (a `reasoning_effort` field, a `reasoning` object, or the messages API's `output_config`). The levels shown are the ones the service's own documentation lists for the model (the table, with its sources, is `knownEffort` in `presets.ts`); where it lists none, or the service is your own or a local server, only Auto shows until you list levels yourself. If a server turns the effort field down (a 400 that names it), the same request is sent again without it once, the model is taken as one without an effort setting for the session, and one sentence says so. A model entry accepts effort levels when it sets `"reasoning": "effort"` (low, medium, high) or lists them itself:

```json
"deep": { "baseUrl": "https://api.example.com/v1", "model": "large-1", "efforts": ["low", "medium", "high", "xhigh"] }
```

A program entry can list the models it can be told to use. `id` is what the program is given after its model flag, and `default` leaves the choice to it:

```json
"assistant": { "command": "agent-cli", "models": [{ "id": "default", "name": "Let it choose" }, { "id": "large", "name": "Large" }], "efforts": ["low", "high"] }
```

A conversation held through a program (one you are signed in to) has the same five modes as any other, and each means the same: Ask asks before changes and commands, Edits edits files and asks before commands, Plan changes nothing, Auto asks only when something cannot be undone, and Bypass never asks. navvied decides, not the program: it checks every tool before it runs, with your permission rules and the same risk check as its own engine, and where a mode asks, the question comes to you as the usual card (Allow, Allow and do not ask again, Edit, Deny). Plan and Bypass are the program's own read-only mode and its mode with no questions. If navvied cannot be asked, nothing runs: before it starts a program it runs its own guard once, the way the program will, and if that does not start and answer on this computer it says why and runs nothing. If the guard stops working after that, the program's own default mode refuses what needs permission in Ask, Edits and Auto (nobody can be asked), Plan stays read only, and only Bypass, which turns the program's own questions off because you asked for that, would run a tool unchecked.

## Connected programs (MCP)

Programs that give the agent more tools are listed under `"mcp"` in the configuration file. Each is started when a conversation starts and spoken to over its standard input and output. Its tools are named `mcp__<program>__<tool>`, are offered to the model next to the built-in ones, and ask for approval in Ask mode unless the program says they only read. A program that cannot start is reported once, in words, and the others carry on. A small model is shown a program's tools only when the request names the program or the tool.

```json
"mcp": { "notes": { "command": "notes-server", "args": ["--folder", "~/notes"], "env": { "NOTES_TOKEN": "..." } } }
```

Programs run with your own permissions. Add only programs you trust.

## Starting the engine from another program

`navvied serve --http --port 0 --ready-line` prints exactly one line on standard error once it is listening, `navvied-ready {"port":N}`, and nothing that holds the key. With `--exit-when-stdin-closes` it stops when its standard input closes, so it ends with the program that started it. `NAVVIED_NO_UPDATE=1` turns the self-updater off. A desktop shell is built on these three.

## Skills

A skill is a folder with a `SKILL.md`: a block between two `---` lines with `name` and `description`, then the instructions. Put your own in `skills/` next to the configuration file, and a project's in `.navvied/skills/` inside the project (a project skill with the same name replaces your own). The model always sees the names and descriptions, and reads the whole text with the `Skill` tool when a task matches. The format is the common one, so skills written for other agents work as they are.

## Helpers

The `Agent` tool hands a research task to a helper: a second run of the same model that can only read and search, starts from nothing but the task, and answers with what it found. Its steps are shown under the step that asked. A helper cannot change anything and cannot ask for another helper. A small model is not offered it.

## Hooks

Commands that run around what the agent does are listed under `"hooks"` in the configuration file, by event: `PreToolUse`, `PostToolUse` and `Stop`. Each has a `command`, an optional `matcher` (a pattern for the whole tool name) and a `timeout` in seconds (default 30). The command gets a JSON description of the event on standard input. Before a tool, exit code 2 stops it and what the command wrote on standard error is told to the model. A command that fails or runs too long is only a note. Hooks run with your own permissions and come only from your own configuration.

```json
"hooks": { "PreToolUse": [{ "matcher": "Bash", "command": "~/bin/no-force-push.sh" }] }
```

## Memory

The `Remember` tool keeps one short fact for later: in `.navvied/memory.md` of the project, or in `memory.md` next to the configuration for every project. Both are plain files, read at the start of each conversation together with `NAVVIED.md`. `/memory` shows them, opens them, and adds a note.

Notes and earlier conversations are found by their words, even with a typo, an accent or a missing space (Chinese, Japanese). To find them by meaning too ("how do we format dates" finds "we use ISO 8601"), point navvied at a server of your own that turns text into vectors, in the configuration file. It is off until you do, and nothing is sent anywhere else:

```json
{ "memory": { "embeddings": { "baseUrl": "http://127.0.0.1:8080/v1", "model": "your-embedding-model", "api": "chat", "apiKeyEnv": "EMBEDDINGS_KEY" } } }
```

`api` is `chat` for a server with the usual `/embeddings` call (a local `llama-server` started with an embedding model and `--embeddings`, or a service on your own key) or `ollama` for `/api/embed` (then `baseUrl` is `http://127.0.0.1:11434`). The key is optional; `apiKeyEnv` names a variable that holds it, and `apiKey` writes it in the file (keep the file private). The address must be `https`, or `http` on this computer. Secrets are hidden from the text before it is sent. The vectors are kept in `search.vectors.sqlite` next to the search index, and made again if you change the model. If the server is down, searches answer by words and say so in one line.

## Other devices

`/web` opens this conversation in a browser on this computer. `/remote` makes a link for another device (a phone, another computer): open it there and the page asks to connect through the relay, which moves sealed messages and cannot read them; the first time, you are asked here and shown the same code. `/devices` lists what is allowed and removes it. See `docs/RELAY.md`.

## Searching the web

The agent can search the web with `WebSearch` and read a page with `WebFetch`. By default search asks keyless sites in turn until one answers. First the ring: four search services whose own documents say that a program may ask them without a key (Exa, Parallel, Keenable and Tavily; the words searched for go to the one that answers, with the program's name and no key). The ring starts at a different service for each search, so none takes all the questions. Then DuckDuckGo's page, then its lighter page, then navvied's own search (a search made by navvied.com for this computer, for networks that block the public pages: the words searched for go to navvied.com, which keeps neither them nor who asked; a signed-in computer uses its account's allowance, any other is a guest with a smaller one), then a search of Wikipedia (results from a later site are said to be from it). A site that cannot be reached (on some networks a site is blocked and answers with a certificate that is not its own, which is never accepted), that is slow, that is limiting its free use, that answers with a page that is not its own, or that asks for a human check, hands over to the next. The same words asked again within 20 minutes are answered from memory. `NAVVIED_SEARCH_ORDER` names the sites and their order (`exa`, `parallel`, `keenable`, `tavily`, `duckduckgo`, `duckduckgo-lite`, `navvied`, `wikipedia`; for example `wikipedia,duckduckgo`); an order that is named is followed exactly. To use your own search server (one that answers `?q=…&format=json`, such as SearXNG), set `NAVVIED_SEARCH_URL`; it is used alone.

`WebFetch` gives a page as text: the main content, headings, lists, code, tables, and the page's links as `[n]` with their addresses at the end. A long page ends with the call that reads on (`offset`); the text is kept 15 minutes, so reading on costs no second visit. PDFs are read; pictures and other files are refused with a sentence. Redirects on the same site are followed, another site is named and left to the model. Every name is looked up and every address must be public, on each hop; a name that does not resolve is refused, and the visit goes to the address that was checked (a name that changes its answer in between reaches nothing else). An address that carries what looks like a key or a token is refused. A page is read in its own characters (the header, the page's own word, or UTF-8). What the web says (a page, a search, the browser) always comes inside one frame that says it is text from the web, information and not instructions, and a page cannot close it. `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` and `NO_PROXY` are followed (a request through a proxy is connected by the proxy, so the address is checked but not pinned), and `NODE_EXTRA_CA_CERTS` or `SSL_CERT_FILE` adds a certificate authority for networks that inspect traffic; a certificate that fails is never accepted.

An address the model made up is asked about (in Ask and Plan modes; refused in Edits; Auto and Bypass go through): only addresses the person wrote, a search returned or a page that was read are fetched without asking, and allowing a site remembers the site for the session. `NAVVIED_ALLOW_PRIVATE_NETWORK=1` lets the agent reach local and private addresses (for a test server of your own).

## Looking at media, speech, pictures and video

Six tools are offered only where something can do their work, so a computer with nothing set up sees none of them and the Tools list says "Needs setup". `LookAt` (a picture or one page of a PDF) and `Watch` (a video: six frames cut out with ffmpeg) ask a model that sees pictures and return words, so a text-only model can use them; the model is the one named in `media.vision.model`, else the conversation's own when it sees pictures. `Transcribe` turns a sound or video file into text, `Speak` reads a text into a sound file, `MakeImage` and `MakeVideo` make a file from a description. Files go in the project; a file that exists is never replaced unless the call says `overwrite`. Text that comes out of a recording or a picture is framed as text from outside, like a web page.

Engines on this computer come first, then the service for a signed-in computer (`/api/media`, only the kinds it lists as free). Name them in `config.json`; nothing is downloaded, and an engine is offered only while its program and every file it names exist:

```json
"media": {
  "stt":   { "bin": "/opt/whisper/whisper-cli", "model": "/opt/whisper/ggml-base.bin", "language": "en" },
  "tts":   { "engine": "piper", "bin": "/opt/piper/piper", "model": "/opt/piper/en_US-lessac.onnx" },
  "image": { "bin": "/opt/sd/sd", "model": "/opt/sd/model.safetensors" },
  "vision": { "model": "the name of a model entry that sees pictures" },
  "ffmpeg": "/usr/bin/ffmpeg", "pdftoppm": "/usr/bin/pdftoppm"
}
```

`stt` is whisper.cpp, `tts` is Piper or (with `"engine": "kokoro"` and a `voices` file) Kokoro, `image` is stable-diffusion.cpp. The programs start with this program's environment without any variable that looks like a key. A provider that costs money is never used.

## Checkpoints

Before each message the agent works on, navvied saves a git snapshot of the repositories involved (the working tree,
untracked files included, ignored files not). A repository the agent first writes to in the middle of a turn is
snapshotted just before that write. Your own index, branches and files are never touched by taking a snapshot.

```
navvied checkpoints --session <id>               # list
navvied restore <checkpoint> --session <id>      # preview what would change
navvied restore <checkpoint> --session <id> --yes
```

In the interactive session: `/checkpoints`, then `/restore <number>` and confirm with `y`. A restore reverts edits,
brings back deleted files and deletes files created since; it first saves the current state as a new checkpoint, so
it can be undone with `restore <undoId>`. Only code is restored, not the conversation. Changes made by shell commands in
a repository the session never wrote to directly are covered only if it is the working directory's repository.
Checkpoints need the built-in engine; an external agent program keeps its own history.

## The models we host: /login

Type `/login` (or press Enter on the first screen when nothing is connected and choose "The models we host") to use the models that navvied hosts, with your files and tools staying on this computer. Everything is a menu: move with ↑ ↓ and press Enter.

- **Sign in with my browser** is the easiest: a page opens, you check that it shows the code your terminal shows, press Approve, and the terminal connects by itself. There is nothing to type.
- **Sign in with email and password** types them here (the password is hidden), for a computer with no browser.
- **Create a free account** makes the account, then signs in.

Once signed in, the models of your account appear in `/model` with their names and what each is good for; one that needs a plan is shown but locked. The account is the same one you use on navvied.com, so the same models and the same rights follow you between the terminal, the browser and the app. `/logout` signs this computer out and cancels its sign-in on the server. Your own models and everything stored on this computer are untouched either way.

The sign-in is kept in `account.json` next to the configuration file (readable only by you); the list of models is refreshed each time navvied starts and is remembered when you are offline. Set `NAVVIED_SERVER` to use another server than navvied.com.

## Project instructions

Put standing instructions for the agent in a `NAVVIED.md` file: how to build and test, conventions, things to avoid.
The agent reads, in order: `~/.config/navvied/NAVVIED.md` (yours), then one file per folder from the project root (the
nearest directory with `.git`) down to the working directory. Inner files come last, so they win. In each folder the
first of `NAVVIED.md`, `AGENTS.md` and the instruction file of another popular coding agent (the list is in
`packages/cli/src/presets.ts`) that has text is read, and only that one, so a project already set up for another agent
works as it is and nothing is read twice. The files are read again on every turn, so an edit applies
at once. Each file is capped at 20 KB, the total at 60 KB.

## Using a command-line agent you are already signed in to

A model entry can name a program instead of an HTTP endpoint. The program must be an agent that streams JSON lines
(partial text, tool calls, a result per turn). navvied starts it, translates its stream into the navvied protocol, and
shows it like any other engine.

```json
{
  "models": {
    "subscription": { "command": "agent-cli", "args": [], "model": "large", "window": 200000 }
  }
}
```

* **Sign-in stays with that program.** Run its own login once (it opens a browser for OAuth and stores the credentials
  itself). navvied never sees, stores or forwards the token. To pass a token through the environment instead, use
  `"env": { "NAME": "value" }`.
* **Capabilities** are announced honestly: `auto` and `plan` modes, steering, session resume with `--session`, and no
  on-demand compaction or ask mode. A front-end therefore shows only what works.
* **`plan`** starts the program in its own read-only mode; the plan comes back as text with a proposal to approve.
* Changing the mode or effort between turns restarts the program on the same session.

Use this on your own machine with your own account. A subscription login is personal: do not share one login between
several people through a server.

## `run`

```
navvied run "fix the failing login test"
navvied run "add input validation to src/signup.ts" --mode plan
echo "summarise the changes on this branch" | navvied run
navvied run "update the changelog" --mode ask --yes --json
```

The answer is printed on **stdout**; tool steps, plans, usage and errors go to **stderr**, so the output can be piped.
With `--json`, stdout carries one protocol event per line instead.

Exit codes: `0` done · `1` the task failed · `2` usage or configuration error · `130` cancelled.

In `ask` mode there is nobody to approve, so tool calls are refused unless you pass `--yes`.

## Interactive session

`/mode <ask|edits|plan|auto|bypass>`, `/go` (approve the proposed plan), `/compact`, `/clear`, `/session`, `/help`, `/exit`.

**Several conversations at once.** `/clear` (a new conversation) and `/resume` (open another) work while a reply is being written: the one being answered goes on in the background (up to 4), and you are told in one line when it is done or waits for your answer; `/resume` opens it again, with what it said so far, and the one you had open goes to the background if it is being answered. The same holds for the page and the app.
Ctrl+C cancels the running turn; pressed again (or while idle) it quits. When a tool asks for approval, type `y` or `n`.

## `serve --stdio`

Reads protocol commands from standard input, one JSON object per line, and writes protocol events to standard output
(see [PROTOCOL.md](PROTOCOL.md)). Standard error is for diagnostics only. Closing standard input lets a running turn
finish, then the process exits 0. A host (a web server, an editor) starts one process per conversation.

## Automatic updates

While you use the interactive app, the installed program checks for a newer release when it starts and every ten minutes after. A check only downloads a small checksum file; the program itself is downloaded only when it changed. It is verified, replaces itself, and the footer shows "Update installed · restart to apply". Nothing changes while you work; the new version starts the next time you run `navvied`.

Turn it off with `"autoUpdate": false` in the configuration file, or by setting `NAVVIED_NO_UPDATE=1`. A copy run from source is never touched.

## Connecting a model

There is one place to add a model: `/providers`. The first run, `/model`'s last row, "Add model", and `navvied init` from a shell all open it. `/model` only chooses between what is already connected. Everything is chosen with the arrow keys, Enter, Left (back) and Esc (cancel); typing is only for a key, a field, an address or a search.

* **Accounts**: the navvied account (Sign in shows an address and a code to approve on navvied.com; Sign out), and the two programs you sign in to with a plan, each connected through its own official program: Install it, Sign in (the program's own browser sign-in opens on this computer), Sign out. navvied never sees the password or the token.
* **API keys**: every service in the list, with the key page, the region and the other fields it needs.
* **Custom Endpoints** and **Local Models**: see `/providers` in the table below.

## Permission modes

How much navvied may do without asking. Switch with Shift+Tab, `/mode`, or `--mode`.

| Mode | Runs without asking | Asked about |
|---|---|---|
| **Ask first** (`ask`) | reading, and commands that only look (`ls`, `cat`, `grep`, `git status`, `git diff`, `git log`…) | every change and every other command |
| **Accept edits** (`edits`) | the above, file edits, and plain file commands (`mkdir`, `touch`, `mv`, `cp`) | other commands |
| **Plan only** (`plan`) | reading | nothing changes until you approve a plan |
| **Auto** (`auto`, the default) | everything | only what cannot be undone (below) |
| **Bypass permissions** (`bypass`) | everything | nothing (what is never done still holds); for a sandbox, or when you accept the risk |

**What Auto still asks about, and a rule that allows "git" does not allow:** `git push --force` (any form), `git push --delete`, `git reset --hard`, `git clean -f`, `git checkout -- .` and `git restore .`, `git stash drop`, `git commit --amend`, `git branch -D`, rewriting history; deleting wide sets of files (`rm -r` outside the project, on `*`, `.` or a home folder); `sudo`; a downloaded program piped into a shell (`curl … | sh`); `DROP TABLE` and the like; `chmod -R`, `kill -9`, `docker system prune`, `kubectl delete`, `npm publish`; and changes to files that set up your shell, keys or git (`~/.bashrc`, `~/.ssh/`, `.git/`, `.mcp.json`, navvied's own setup). The question says why, in plain words. **"Allow, and do not ask again" covers that kind of thing and nothing else**: allowing force pushes does not allow `git reset --hard`, and a rule `Bash(git *)` still lets the rest of git through without asking. A helper (an agent started by the agent) cannot be asked, so it is refused instead. Nothing the agent does can change `.navvied/permissions.json` or `config.json`: it never changes what it is allowed to do.

## Permission rules

Besides the modes, you can say in `config.json` what navvied may always do, must always ask about, and may never do:

```json
{
  "permissions": {
    "allow": ["Bash(npm run *)", "Bash(git status)", "Edit(src/**)"],
    "ask":   ["Bash(git push *)"],
    "deny":  ["Edit(**/.env)", "Read(/etc/**)", "WebFetch(domain:example.com)"]
  }
}
```

* A rule is a tool name, or a tool name with a pattern: `Bash(npm run *)` (a command; a trailing ` *` also matches the bare command), `Edit(src/**)` or `Write(notes/*.md)` or `Read(...)` (a file, relative to the project: `*` stays in a folder, `**` goes deeper), `WebFetch(domain:example.com)` (the site and its subdomains), or just `Bash` for every use.
* **Deny beats ask, and ask beats allow.** Deny stops the tool in every mode and tells the model not to try again. Ask asks in every mode, Bypass too. Allow does not ask in Ask mode, and never lifts what Auto asks about (above).
* A command joined to another with `&&`, `;`, `|` or `||` is allowed only when **every part** is covered, and a command that hides another inside `$(…)`, backticks or `<(…)` is never allowed by a rule.
* A project may add its own `.navvied/permissions.json` with the same lists, but only its `ask` and `deny` rules count: a project cannot allow anything, because it is not your own word.
* **Never done, whatever the mode or the rules** (a short list on purpose): deleting the whole disk or home folder (`rm -rf /`, `~`, `$HOME`), formatting or overwriting a disk (`mkfs`, `dd of=/dev/sd…`), switching the computer off (`shutdown`, `reboot`), changing the rights of every file (`chmod -R … /`), a fork bomb, and writing over a system folder (`/etc`, `/usr`, `/bin`, `/boot`…).

## A second choice when a model cannot be reached

```json
{ "default": "big", "fallback": ["small-local"], "models": { "big": { "...": "..." }, "small-local": { "...": "..." } } }
```

When the chosen model cannot be reached (no network, a busy or broken service, no answer in three minutes), the next one in `fallback` answers that message and you are told once. A wrong key or a request the service refuses is shown as it is and is never hidden by another model. A model that already started answering is not replaced halfway. Only models navvied runs itself take part, not models reached through a program.

## Where commands run

By default the agent runs commands on this computer. `/tools` (or a page's Tools screen) can send them somewhere else: only the commands move, files are still read and written here.

```json
{ "terminal": { "docker": { "image": "debian:stable-slim" }, "ssh": { "host": "build.example.com", "user": "me", "dir": "/srv/app" } } }
```

* **Docker or Podman:** one container per working folder, started the first time and kept while the program runs, with the project folder mounted at `/work`; a command works in the same folder of the project it would work in here. Programs you install in it stay until the program ends, when the container is removed. `image` is optional.
* **SSH:** the command runs on `host` (in `dir` there, when given). It must log in without asking for a password (a key or the ssh agent). The host is set here, never from a page.
* **The sandbox (this computer only):** a command that runs on this computer is confined by default: it can write the project, the temporary folders, the program's own work folders and the usual download caches (`~/.cache`, `~/.npm`, `~/.bun`, `~/.cargo` and the like); it can read everywhere except the places that hold keys (`~/.ssh`, `~/.gnupg`, `~/.aws`, browser profiles, `.env` files outside the project, this program's own configuration); the network is on. Linux uses bubblewrap (`bwrap`, with a filter that refuses system calls such as ptrace and mount), macOS uses Seatbelt; Windows is not isolated. Every confined result ends with one line saying what was really in force, and where no sandbox is possible (no `bwrap`, user namespaces switched off, Windows) the first result says so and the command runs as it is: a command is never refused for that. When the sandbox stops a command (it tried to write outside the project, or to open a hidden place) you are asked to run that one command outside it (Ask and Edit modes; in Auto only when the place is outside the project; Bypass runs it; Plan does not); "do not ask again" covers the folder. On Linux a confined command cannot look at your other programs by itself, so `ps`, `pgrep`, `pidof`, `pkill`, `killall`, `ss`, `lsof` and `fuser` are answered by navvied outside the sandbox: they only look (options that write, kill from there, read a named file or show another program's environment are refused), `pkill` and `killall` then signal from inside the command, and what answers them is let go when the last conversation using it ends. Docker and SSH keep their own isolation. Configuration: `{ "sandbox": "off" }` turns it off, `{ "sandbox": { "network": false } }` cuts the network of confined commands; the choice made on the settings screen wins over the file.
* **What a command inherits:** the program's own environment, without the keys it uses itself: every variable whose name has KEY, TOKEN, SECRET, PASSWORD or CREDENTIAL in it, and any variable holding a key from the configuration. PATH, HOME and the rest stay. To let commands keep a variable (for example a token a command line tool needs), list its name: `{ "terminal": { "env": ["GITHUB_TOKEN"] } }`. The variable `NAVVIED_TERMINAL_ENV` (names, comma-separated) does the same for one run.
* **Background commands** write their output to a file in the computer's state folder, so a command that is still running after the program was killed is taken back by the same conversation (output and stop work, typing does not); one that ended meanwhile is reported as ended. When a background command ends, or prints a line with the text the model asked to watch for (`notify`), the conversation continues by itself with what happened and the end of its output, at most 12 times before you write again.
* A place that cannot be used (no Docker, no host) is listed as "needs setup" with what to do, and cannot be chosen. The choice is kept in the computer's state and reaches the next new conversation.

## More hooks

Besides `PreToolUse`, `PostToolUse` and `Stop`, `hooks` accepts `UserPromptSubmit` (before a message is taken: exit code 2 stops it and what the command wrote on standard error is shown; what it printed on standard output is added to the message as context), `SessionStart` (the same, only for the first message of a session) and `PreCompact` (before older turns are summarised; the input says whether the person asked for it).

## Hooks that answer in JSON

A hook may also answer with JSON on standard output (exit code 0): `{"decision": "block" | "ask" | "allow", "reason": "…", "updatedInput": {…}, "additionalContext": "…"}`. `block` stops the tool (or the message) and tells the model the reason; `ask` makes the person say yes first, whatever the mode; `allow` changes nothing, because a hook can only lower what the mode allows, never raise it; `updatedInput` replaces keys of the tool's input and the changed call is judged by the mode and the rules again; `additionalContext` is added to what the model reads. Exit code 2 still stops with the standard error as the reason and wins over any JSON. The input has `event`, `session`, `cwd`, `tool`, `input` and, after a tool, `output`, and also `hook_event_name`, `session_id`, `tool_name`, `tool_input` and `tool_response` for scripts written for other agents. More events: `SessionEnd` (the conversation closes), `Notification` (the agent waits for you; `matcher` is `approval` or `question`) and, for `Stop`, a `block` asks the agent for one more round with the reason (once; the input says `stop_hook_active`). A `matcher` of `*` is every tool. A hook starts with the environment a command of the agent starts with: without keys and tokens unless listed under `terminal.env`.

## Plugins

A plugin is a folder with `navvied-plugin.json` (`name`, `version`, `description`, and the `skills`, `agents`, `commands` it brings as lists of names, `hooks` as in the configuration, `mcp` as tool servers) and the files: `skills/<name>/SKILL.md`, `agents/<name>.md`, `commands/<name>.md` (a custom slash command; `$ARGUMENTS` and `$1` to `$9` are filled in), and anything its hooks and servers run (`${NAVVIED_PLUGIN_ROOT}` is its folder). What the manifest lists must be exactly what is in the folder.

`navvied plugin install <folder | .tar.gz | git address[#tag]> [fingerprint]` copies it into the plugin folder next to the configuration file and records the sha-256 of its files in `plugins.lock.json`; nothing in it is run, and it stays off. A fingerprint on the command line must match or nothing is installed. `navvied plugin show <name>` lists what it brings and every command it would run, each with its source; `on` and `off` switch it for the next conversation; `remove` deletes it. Its files are checked against the lock every time it is loaded, and a plugin that changed is not used. A plugin in `.navvied/plugins/<name>` of a project is used only after you accept exactly those files (`navvied plugin accept <name>`, or the accept step of the skills review), and a change asks again. Links, paths that leave the folder, more than 2,000 files, files over 5 MB and archives that unpack over 64 MB are refused.

## Connected programs on the web

Besides a program started on your computer (`"command"`), a connected program (MCP server) can be one on the web, reached over streamable HTTP:

```json
"mcp": { "issues": { "url": "https://example.com/mcp", "headers": { "authorization": "Bearer <token>" } } }
```

Use `url` or `command`, not both. The headers are sent with every message (a token goes here; the file is kept private). Its tools join navvied's own as `mcp__issues__<tool>`, and are held to the same permission rules as any other tool. A server that cannot be reached, or turns the token down, is reported as a note and the rest carry on.

## Other agents (A2A)

navvied speaks the agent-to-agent protocol (A2A, version 0.3.0 on the wire; answers of version 1.0 are read too), both ways. Both are off until you turn them on.

**Asking another agent.** List the agents in the configuration. A token is never written there: name the environment variable or the private file that holds it.

```json
"a2a": { "peers": { "docs": { "url": "http://127.0.0.1:9900", "tokenEnv": "DOCS_TOKEN", "timeoutSeconds": 120 } } }
```

With at least one peer, a model with room is offered the tool `AskAgent` (a small model, when the request names agents or the peer). It sends one message and returns the answer inside a frame that says it is another agent's words, not instructions, plus a `context` to go on with. It is asked about in Ask mode and is not offered in Plan mode. It has no row in the tools list; switch it off by its name. What leaves is scrubbed of keys; a redirect from the peer is not followed.

**Being asked.** `navvied serve --a2a` (or `"a2a": { "serve": true }` with `serve --http`) serves the card at `/.well-known/agent-card.json` and the calls `message/send`, `message/stream`, `tasks/get` and `tasks/cancel` on `127.0.0.1:8788` (`--port`, `--host`). Nobody is let in without a token you made:

```
navvied a2a add docs        # shown once; the file keeps only a hash
navvied a2a list
navvied a2a revoke docs
```

An agent that asks has no authority here. Its words reach the model framed as another agent's, in a conversation of its own (one per peer and `contextId`; another peer cannot name it). The conversation runs in the mode you set for peers, `"a2a": { "mode": "plan" }` by default (`ask`, `edits` or `auto`; nobody is there to allow a step, so `ask` refuses every change). The agent's file tools stay in the folder it was started in, and it has no memory, notes or standing instructions of yours, cannot save memory or make skills, and cannot ask other agents. Limits, each changeable under `"a2a": { "limits": { … } }`: 64 KB a request, 16,000 characters a message, 30 requests a minute and 2 tasks at once per peer (4 in all), 4 conversations per peer (16 in all) of 20 messages, 10 minutes a task, 32,000 characters an answer, 20 wrong tokens an hour per address. Every exchange is written to `a2a-audit.jsonl` in the state folder, without any token.

**From the web.** When this computer is signed in to your account and runs `navvied serve --http` with A2A on (the desktop app does), agents on the web reach it at `https://<site>/a2a/<handle>/` without opening a port: the relay passes each request over the connection the computer already holds. The handle is the random name in the token file (`a2a-tokens.json`), never your account or address. The relay checks the token first, so a stranger never wakes the computer, and the computer checks it again with the same limits as a direct call. A token you make or revoke with `navvied a2a add|revoke` reaches the relay within a couple of seconds (the relay stores only its hash); turning A2A off, or stopping the server, makes the address answer "not available" (404). Plain `navvied serve --a2a` without `--http` has no connection to the relay and is reached directly only.

## Helpers of your own

A helper is a Markdown file in `agents/` next to `config.json` (yours) or in `.navvied/agents/` of a project (the project's wins on the same name):

```markdown
---
name: reviewer
description: Reviews a change for bugs and missing tests
tools: Read, Grep, Glob
---
You review code. Read the changed files, look for bugs, and answer with a short list.
```

The description is all the agent sees to decide when to hand a task over, so say what it is for. `tools` names the tools it may use; without it the helper may only read. A helper may change things only when it names write tools **and** the conversation is in Auto mode; your permission rules and the hard limits apply to it like to everything else. When the agent asks for several helpers (or other read-only tools) in one step, they work at the same time.

## In scripts: `navvied run`

`navvied run "<task>"` does one task and exits: `0` done, `1` failed, `2` wrong usage, `130` cancelled. Piped text is the task (`echo "fix it" | navvied run`). Useful flags: `--json` (every protocol event as a JSON line, see `docs/PROTOCOL.md`), `--yes` (allow tool calls with nobody to ask), `--mode`, `--model`, `--effort`, `--session <id>` (continue a saved session), `--cwd`.

* `--last` prints only the final answer, not the steps.
* `--answers '<json>'` answers the questions the agent asks (`AskUserQuestion`), in the order they come: a JSON list with one entry per question, each a word or a list of words. Without it nobody can answer in a run: the agent is told to make a reasonable assumption, say so, and go on.
* `--schema <file>` takes a JSON Schema: the answer must be JSON that matches it, and **only that JSON is printed**, on one line. If the first answer does not match, the model is told exactly what was wrong and gets one more try; if it still fails the exit code is `1`, nothing is printed on standard output, and the reasons are on standard error. The checker knows types, `properties`, `required`, `additionalProperties: false`, `items`, `enum`, `const`, bounds, lengths, `pattern` and `anyOf`; anything else in the schema is not checked.

## Tasks that run by themselves

```
navvied schedule add "0 9 * * 1-5" "summarise yesterday's commits"          reads and plans only (the default)
navvied schedule add "30 18 * * *" "run the tests and fix what is simple" --mode auto
navvied schedule list
navvied schedule remove <id>
navvied schedule run <id>        run one now
navvied schedule run-due         run what is due, once, and exit
```

The schedule is five parts: minute, hour, day of the month, month, day of the week (`*`, a number, `a-b`, `a,b`, and steps such as `*/15`; also `@hourly`, `@daily`, `@weekly`, `@monthly`). Each task runs as `navvied run` in the folder where it was added. Without `--mode auto` it can only read and plan; with it, it may change files, held to your permission rules and the hard limits, with nobody to ask. What it said is kept in `scheduled/<id>/` in navvied's state folder.

The model can make and change these tasks itself with the `Schedule` tool, when a request is about timing and the model is not a small one: a task can run once (`in 20 minutes`, `2026-12-01 09:00`), every so often (`every 2h`, never under a minute), daily or weekly (`weekdays at 9:00`), or on five fields, in a time zone you name. A task made that way reads and plans only unless it is made with mode auto, which you are asked about like any other change. A task that came due while nothing ran starts once and its run says when it was due. A hosted session's tasks are the cloud's instead (see `HOSTED.md`). The tool is switched off with the Schedule row of the tools list.

Tasks run while navvied is open (a line says when one finishes), and a task that came due while nothing was running starts once at the next chance. For tasks to run with navvied closed, call `navvied schedule run-due` from the system's own timer every minute: cron (`* * * * * navvied schedule run-due`), launchd or systemd. `/schedule` in the app lists the tasks.

## In an editor: `navvied acp`

`navvied acp` speaks the Agent Client Protocol (JSON-RPC, one message per line on standard input and output), so an editor that supports it can use navvied as its agent. For Zed, in its settings:

```json
{ "agent_servers": { "navvied": { "command": "navvied", "args": ["acp"] } } }
```

Each session is an engine of its own in the folder the editor names. The answer, the thoughts, the tool steps (with their kind: read, edit, execute, search, fetch) and the plan arrive as updates while it works. In the default mode (Ask) a change to a file or a command is a permission prompt in the editor, with "allow", "allow always" and "deny"; `--mode auto` skips the questions, `--mode plan` only reads. Your permission rules and the hard limits apply as everywhere. The editor's cancel stops the work. Not in this version: opening a saved session from the editor, images and audio.

## Reading documents

The Read tool also reads `.docx`, `.xlsx`, `.pptx` and `.pdf` files and gives their text as numbered lines, so a spec or a report can be read like code:

* **Word:** paragraphs, and tables as rows with cells joined by ` | `.
* **PowerPoint:** each slide's text under `--- Slide n ---`, in order.
* **Excel:** each sheet as rows of tab-separated cells (the first 500 rows), under `--- Sheet: name ---`.
* **PDF:** read by `pdftotext` when this computer has it (best; part of poppler: `brew install poppler`, `apt install poppler-utils`). Without it, a plain reader finds the text in the pages, which works for most PDFs made from text but not for scanned pages (they need OCR) or unusual fonts.

Nothing is installed or sent anywhere: the files are opened on your computer. Images inside documents are not read.

## The same things the page does

Everything the web page and the phone do with a computer's hub is a command to that hub, so the terminal has it too:

| In the terminal | What it does |
|---|---|
| `/resume` | The earlier conversations (★ pinned, ● unread, ✓ done, `cloud` for one waiting in the cloud); pick one and choose: open it, pin, rename, mark read or done, fork, archive, move to another of your computers, delete (asks first). For a cloud one: bring it here, copy it here, read it, delete it. |
| `/search <words>` | Finds a conversation by what was said in it. |
| `/folder` | Choose the folder the next conversation works in, from the ones this computer offers (the start folder, the ones used lately, and `"folders"` in `config.json`). |
| `/import` | Brings the conversations waiting in the cloud (from hosted sessions) to this computer; a line at the start says how many wait. |
| `/move <computer id>`, `/copy <computer id>` | Sends the open conversation to another computer of your account (through the relay, sealed; nothing goes to the cloud). |
| `/providers` | Where a model is added: **Accounts** (the navvied account, and the two programs you sign in to with a plan), **API keys** (every service: region, key, fields, another address; Save keeps them and lists the service's models), **Custom Endpoints** (a server of your own, tried with Find models), **Local Models** (install or remove the runtime, Ollama, a short list or a search of Hugging Face with a fit for each result, download with pause and resume, run and stop). Keys and endpoints stay on this computer; none of it is available in Navvied Cloud. |
| `/plugins` | Skills, tool servers, hooks and plugins. Enter switches a skill or a hook; a connected program opens its own screen (switch, sign in in the browser, what it offers: tools, resources, prompts); a project's plugin asks for your trust first; the last row installs one from a folder or an address, after showing what it brings and its fingerprint. |
| `/tools` | What the agent can do on this computer: six categories (Work, Browse & research, Plan & coordinate, Memory & knowledge, See, hear & create, Control the computer), each with its tools, and every tool with its own on or off (Files & Search is one). Enter switches one where it stands; a tool coding is made of asks first. A tool that waits for setup, is not built yet (Soon) or cannot run here has no switch. Where commands run: this computer, a Docker or Podman container, or another computer over SSH. A change reaches open conversations at their next step. |
| `/artifacts` | The files conversations wrote; pick one to show it (text; a picture says where it is). |
| `/schedule` | The scheduled tasks with when each runs next and how the last run went (a run missed while the computer was off is said); New task asks its name, what to do, when (every day, every weekday, every week on a day, every month on a day, once at a date and time, every few minutes or hours, or a cron line), at what time and what it may do (only read and plan, or can change files), one question at a time; for a task: run now, turn it off or on, what it said before (the last three runs; a failed one says why and can be run again), change it, remove it (asked first). `navvied schedule add` still adds one from the command line. |
| `/open` | The files this conversation made (a picture, a sound, a video, a download): open one with this computer's own program, or show its folder. |
| `/agents` | The other agents that may ask this one: make an access token (shown once) and take access back (asked first). |
| `/screen` | While Computer Use is on: take the screen over (navvied waits), give it back, or stop. The bottom bar says which application it is using, or that it is paused. |

Not in the terminal yet: switching between an agent and a chat inside one session (start `navvied --kind chat` for a chat), and the hosted-model choice screen of the page (`/model` lists the models of your account, the free ones and your own).

## Chat and agent

`navvied` works in a project folder: that is an **agent** (shell, git, helpers, permission modes). `navvied --kind chat` starts a **chat** instead: a conversation with a folder of its own (`<state>/navvied/chat/files`), where it can search and read the web, read what you put there, write files for you (documents, data, code), and remember things. It cannot see or change anything else on your computer, so it asks nothing and has no modes, helpers, skills, checkpoints or project instructions. It can run commands only inside a sandbox (a hosted session; `--sandboxed` tells the program it is in one). A chat needs a model that navvied runs itself, not one reached through another program.

The two never share anything: their saved conversations, the record of what was said, the search index and the folder are separate (`<state>/navvied/chat/...` against `<state>/navvied/...`). A page connected to this computer (`navvied serve --http`) can have both open at once: its commands and the engine's answers carry `kind` (`chat`; an agent has none), and `sessions` and `search` answer for one kind at a time. See [PROTOCOL.md](PROTOCOL.md).

## How the work is shown

Each step the agent takes is one line when it ends: a mark, what it was, and on the right how long it took (the wait for your answer is not counted):

```
✓ Read README.md   3 lines                                          <0.1 s
✓ Search source for compaction events        [output shortened]     <0.1 s
✗ Run chat-ui tests failed                                  exit 1   3.0 s
◉ Start dev server                                running in the background
⏱ Watch tests                                           timed out · 2.0 s
```

`✓` done, `✗` failed (with the exit code and the last lines it said), `−` you said no, `⊘` blocked by a rule or a hard limit (with the reason), `⏱` timed out, `■` stopped, `»` skipped because the turn was stopped, `◉` started in the background. A note in brackets says when the output was shortened or when you changed the command before it ran. While a step runs, the live line shows the last lines it printed, and the steps still waiting are listed as `○ Next: …`. A turn closes with what it came to: `Ran 5 commands, read 1 file · 1 failed · 1 timed out · 10 s`.

When it asks before running a command, **Change the command first** lets you edit it; what you typed is checked against the same limits and rules as anything else.

## A browser for the agent

When the work is about the web (an address in your message, "browse", "log in to the site"…) and a Chrome, Chromium, Edge or Brave is on this computer, the agent can use it: open a page, read it, click, fill in fields, choose, scroll, go back. The page comes back as text with every link and control numbered, so the agent says "click 7". The browser is started with a profile of its own that is thrown away, so it has **none of your logins, history or cookies**; it closes by itself after five minutes of not being used. Local and private network addresses are refused (also when a link or a redirect leads to one) unless navvied was told to allow them. Set `NAVVIED_CHROME` to a browser's path if it is somewhere unusual. In Ask mode each page it opens is a question, and `"Browser"` / `"Browser(domain:example.com)"` work in the permission rules.

What the browser may reach follows the same rule as the web tools. Every request a page makes (its address, a redirect, a picture, a script's fetch) is held until the name has been looked up and every address it has is public; one that points to this computer or its network, or whose name cannot be looked up, is refused, unless `NAVVIED_ALLOW_PRIVATE_NETWORK=1` lets the agent reach them. One thing is not covered: a WebSocket connection the page opens is not held by the browser's request interception (the browser's own blocking by address does not apply to it either), so a page can still open a WebSocket to a service on this computer. Do not run a service that trusts anything that connects to it while the agent browses pages you do not know. `NAVVIED_BROWSER_ARGS` is a list of extra flags for the browser, written as a JSON array of texts, for a proxy or a test.

While it works, the line under your message shows what it is doing, how many steps are done and for how long, the agent's own task list ticked off as it goes (`☑` done, `◐` now, `☐` next), the last lines of the command that runs, and the steps that wait (`○ Next`). A finished command shows its first two lines and how many more there are.

## The work and the report

What the agent **did** and what it **says** are shown apart. The steps sit in a block that starts with `⚙ Work` and has a rail on the left; it closes with a line saying what it came to (`└ Ran 5 commands, read 1 file · 1 failed · 9.0 s`). The answer comes after it under `⬢ navvied  report`. If the agent works, says something, and works again, there are two blocks and two reports. `/steps` shows every step of the last turn in detail (what it ran, how long it took, and what it printed); `/output` shows the last step's output in full.

### The steps of a block

As in the web UI, every step of a finished block stays on the screen as **one line** (mark, what it did, how long it took); a step that went wrong (failed, refused, timed out, stopped) or changed a file shows more under its line: what it said, or the diff. The header says what the block came to (`⚙ Work  Ran 5 commands, read 1 file  ·  1 failed  ·  6.7 s  ·  Ctrl+O for details`). While the block is working, the live area lists the steps so far (the last eight) above the spinner and the last lines the running step printed. **Ctrl+O** opens every step of the turn in full on a page of its own: what each one ran and everything it printed. The arrows, PageUp/PageDown, Home/End and the mouse wheel scroll; it follows the end while work is still going on; Esc, `q` or Ctrl+O close it. It works while the agent is working. `/steps` prints the same in the conversation (40 lines per step) and `/output` the last step's output in full.

The configuration key `"steps"` changes this: `"list"` (the default), `"fold"` (the steps that went well are folded into the header: `4 folded: Ctrl+O`) or `"all"` (every step shows everything it printed).

The configuration key `"applyPatch"` says whether the model is offered the `apply_patch` tool (one patch that changes several files, all or none): `"auto"` (the default: offered to a model with a large window, not to a small one), `"on"` (always) or `"off"` (never).
