# Architecture

```
   front-ends                          engine                           models
 ┌─────────────┐   commands    ┌───────────────────────┐   requests   ┌──────────────┐
 │ CLI         │ ────────────► │ session · loop        │ ───────────► │ provider     │
 │ web         │               │ tools · permissions   │ ◄─────────── │ (API, local, │
 │ desktop     │ ◄──────────── │ context · checkpoints │   streamed   │  CLI, …)     │
 └─────────────┘    events     └───────────────────────┘   replies    └──────────────┘
        └──────────── protocol (JSON lines) ────────────┘
```

## Principles

1. **The protocol is the product boundary.** Front-ends and engines depend on it and on nothing else of each other.
   Anything a user can see or do is a command or an event.
2. **Capabilities, not names.** A front-end shows a control only if the engine announced the capability (`caps`).
   Nothing branches on which model or vendor is behind the engine.
3. **Small and dependency-free.** The protocol and the engine use only the platform. A feature that needs a dependency is
   a plugin, not core.
4. **Safe by construction.** Plan mode does not *ask* the model to behave: write-capable tools are never offered to it.
   Ask mode blocks the tool until the user answers. Cancelling kills running commands.
5. **Deterministic to test.** The engine takes its collaborators (model provider, clock, file system, process runner) as
   parameters, so the whole loop runs against a scripted model in tests.

## Packages

| Package | Responsibility |
|---|---|
| `protocol` | Message types, JSON-lines codec, validation, limits. |
| `engine` | Session state, the turn loop, tools, permission modes, context accounting and compaction, session store. |
| `cli` | Terminal front-end (`navvied run`, interactive) and `navvied serve --stdio` for hosts that embed the engine. |

## Engine internals

* **Provider** — turns a conversation into a streamed model reply: text, reasoning, tool calls, token usage. One
  implementation speaks the common chat-completions API (hosted keys and local servers alike); others plug in behind the
  same interface.
* **Tools** — one file per tool; each declares its schema, whether it is read-only, a human title for approvals, and a
  `run`. Read-only tools never need approval.
* **Permissions** — `auto` runs everything, `ask` pauses on every non-read-only call, `plan` removes them entirely and
  adds a tool to present the finished plan.
* **Context** — token use is reported after every model call; when it nears the window the engine summarises older
  turns, keeping the recent tail intact.
* **Sessions** — conversation state is saved after every turn and reloaded by id.
