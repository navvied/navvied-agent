/**
 * The navvied agent protocol, version 1.
 *
 * A front-end (CLI, web, desktop) and an engine talk in JSON lines over any byte stream (stdio, WebSocket, pipe).
 * The front-end sends {@link Command}s; the engine answers with a stream of {@link EngineEvent}s. Both sides ignore
 * fields and events they do not know, so the protocol can grow without breaking older peers.
 */
export const PROTOCOL_VERSION = 1;

/**
 * What a conversation is for. `agent` works on a project: the folder, the shell, git, helpers, the person's permission modes.
 * `chat` is a conversation with a scratch folder of its own: it can search and read the web, read what the person gives it and
 * write files in that folder (documents, data, code), and, where it runs in a sandbox, run commands there. It never sees or changes
 * the person's own folders, so it asks nothing. A command or an event without `kind` is `agent`.
 */
export type SessionKind = "agent" | "chat";
export const SESSION_KINDS: readonly SessionKind[] = ["agent", "chat"];

/** How much the agent may do without asking. `ask`: approve each change · `auto`: act freely · `plan`: read-only, propose a plan. */
/**
 * How much the agent may do without asking. `ask`: reads only, the rest is asked. `edits`: file edits and plain file commands too.
 * `plan`: nothing changes until a plan is approved. `auto`: everything runs, except what cannot be undone (force pushes, wide deletes,
 * setup files, sudo…), which is still asked. `bypass`: nothing is asked (the hard limits still hold): for a sandbox or a person who accepts the risk.
 */
export type PermMode = "ask" | "edits" | "plan" | "auto" | "bypass";
export const PERM_MODES: readonly PermMode[] = ["ask", "edits", "plan", "auto", "bypass"];

/** Reasoning effort, lowest to highest. Engines accept the subset their model supports. */
export type Effort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export const EFFORTS: readonly Effort[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

export interface ImageInput {
  mime: string;
  /** Base64 payload, no `data:` prefix. */
  data: string;
}

/** A file the person attached. What it is, is decided by its content, not by `name` or `mime`, which only label it. */
export interface FileInput {
  name: string;
  mime: string;
  /** Base64 payload, no `data:` prefix. */
  data: string;
}

/** What the engine made of an attached file (the content itself is never repeated in events). */
export type FileKind = "image" | "text" | "pdf" | "document" | "refused";
export interface FileNote {
  name: string;
  kind: FileKind;
  /** Pages of a PDF, slides of a presentation. */
  pages?: number;
  /** One plain sentence when the file was refused, was not sent as it is, or has nothing readable in it. */
  note?: string;
}

/* ── front-end → engine ─────────────────────────────────────────────────────────────────────────────────────── */

export interface PromptCommand {
  cmd: "prompt";
  text: string;
  /** Client-chosen id (a UUID). The engine confirms it with a `taken` event; re-sending a known qid is a no-op. */
  qid?: string;
  images?: ImageInput[];
  /** Files of any kind. `images` and `files` together hold at most 8, each at most 15 MB; the prompt needs text, an image or a file. */
  files?: FileInput[];
  effort?: Effort;
  mode?: PermMode;
  /** Paths the session has worked in so far — lets the host snapshot those repositories before the turn. */
  paths?: string[];
}
export interface CancelCommand { cmd: "cancel" }
/** `input` goes with the option that is `editable`: the person changed the command before allowing it. */
export interface ApproveCommand { cmd: "approve"; id: string; optionId: string; input?: string }
/** The person's answer to a `question`: for each question, the choices picked and the person's own words, in the order of the questions. An empty list means that question was skipped. */
export interface AnswerCommand { cmd: "answer"; id: string; answers: string[][] }
export interface CompactCommand { cmd: "compact" }
export interface LoadCommand { cmd: "load"; id: string }
/** Asks for the saved sessions of this engine, newest first (answered with a `sessions` event). */
export interface SessionsCommand { cmd: "sessions"; /** List the archived conversations instead of the others. */ archived?: boolean }
/** Looks for words in what was said in the saved conversations (answered with a `found` event). */
export interface SearchCommand { cmd: "search"; query: string; limit?: number; /** Also look in archived conversations. */ includeArchived?: boolean }
/** Use another of the models in `caps.models` from the next message on. The conversation carries over. */
export interface ModelCommand { cmd: "model"; id: string }
/** Set the reasoning effort from the next message on. `auto` sends none. */
export interface EffortCommand { cmd: "effort"; level: Effort | "auto" }
/** Stop one background command (a `job` event with status `running`). Unknown or finished ids are ignored. */
export interface JobStopCommand { cmd: "job.stop"; id: string }
export interface CheckpointsCommand { cmd: "checkpoints" }
/** With `preview`, only report what restoring would change. */
/** Start a fresh conversation (of the kind the command names). The engine says `session`, and every window gets the new `sessions` list. Not while a turn is running. */
export interface NewCommand { cmd: "new"; /** For an agent: the folder to work in, named by an `id` of `caps.folders` (never a path). */ folder?: string }
/** Bring conversations that the account holds in the cloud (left by hosted sessions, or put there by a person) onto this computer, and remove them from the cloud: all of them, or the `ids`. Answered with `imported` and the updated `sessions`. */
export interface ImportCommand { cmd: "import"; ids?: string[] }
/**
 * Move or copy a conversation to another place: `to` is `"cloud"` (the account), `"this"` (the computer the hub runs on), or the id of
 * another computer of the account. A move removes the source only after the target has it. Answered with `moved` and the updated `sessions`.
 */
/**
 * One part of a conversation sent from another computer of the same account, through the relay (a `move` or `copy` whose `to` is a computer).
 * The parts of one conversation arrive in order; when the last has come, this computer saves it as a conversation of its own and says `received`.
 */
export interface ReceiveCommand { cmd: "receive"; id: string; title: string; project?: string; updated: number; part: number; parts: number; items: HistoryItem[] }
export interface TransferCommand { cmd: "move" | "copy"; id: string; to: string }
/** Copy a conversation into a new saved one (new id, the title with " (fork)", same kind, project and place). Answered with `forked` and the updated `sessions`; a page then `load`s `newId`. */
export interface ForkCommand { cmd: "fork"; id: string }
/** Hide a conversation from the normal list (it is kept, and can be listed with `sessions {archived:true}`), or bring it back. */
export interface ArchiveCommand { cmd: "archive"; id: string; archived: boolean }
/** Mark a conversation read (`read: true` clears `unread`) and/or complete (`done`). Answered with the updated `sessions`. */
export interface MarkCommand { cmd: "mark"; id: string; read?: boolean; done?: boolean }
/** Ask for the scheduled tasks (answered with `schedules`). */
export interface SchedulesCommand { cmd: "schedules" }
/** Schedule a task: `prompt` runs by `cron` (five fields) as an agent in `folder` (an id of `caps.folders`; default: the current one) or, with `kind: "chat"`, as a chat. `mode: "auto"` lets it change files with nobody to ask. */
export interface ScheduleAddCommand { cmd: "schedule.add"; title?: string; /** Give `when` or `cron`, not both (`cron` is `when: {kind:"cron", cron}`). */ cron?: string; when?: ScheduleWhen; /** The time zone `when` is in (an IANA name such as `Asia/Jakarta`); this computer's own when absent. */ tz?: string; prompt: string; folder?: string; mode?: "plan" | "auto" }
export interface ScheduleUpdateCommand { cmd: "schedule.update"; id: string; title?: string; cron?: string; when?: ScheduleWhen; tz?: string; prompt?: string; enabled?: boolean; mode?: "plan" | "auto"; folder?: string }
/**
 * When a task runs, in the one shape the Schedule tool and the screens share. `cron`: five fields (or `@hourly`, `@daily`, `@weekly`, `@monthly`), which also says every day, every weekday, every week on, every month on. `every`: every `ms` milliseconds (at least 60000), counted from its last start; with `start` (ms since the epoch) the starts keep to the grid of `start` plus whole intervals (every 2 weeks on a friday). `at`: once, at `at` (ms since the epoch).
 */
export type ScheduleWhen = { kind: "cron"; cron: string } | { kind: "every"; ms: number; start?: number } | { kind: "at"; at: number };
export interface ScheduleRemoveCommand { cmd: "schedule.remove"; id: string }
/** Run a scheduled task now. */
export interface ScheduleRunCommand { cmd: "schedule.run"; id: string }
/** Ask for the last runs of one scheduled task (answered with `schedule.runs`). `limit` is how many, newest first (default 10, at most 20). */
export interface ScheduleRunsCommand { cmd: "schedule.runs"; id: string; limit?: number }
/** Ask where turning on computer use stands (answered with `computer.state`). */
export interface ComputerStateCommand { cmd: "computer.state" }
/** Ask the system for one grant (its own prompt, or its settings page opens); answered with `computer.state`, which is sent again when the person has granted it. */
export interface ComputerPermissionCommand { cmd: "computer.permission"; id: ComputerPermissionId }
/** Turn computer use on or off for conversations (on only when `computer.state` says `ready`); answered with `computer.state`. */
export interface ComputerOnCommand { cmd: "computer.on"; on: boolean }
/** Ask for what extends the agent on this computer: skills, outside tool servers and hooks (answered with `plugins`). Adding one from a page is `plugin.install`; removing one is done on the computer. */
export interface PluginsCommand { cmd: "plugins" }
/** Switch one on or off. It is kept in the computer's own state; skills follow at once, outside tool servers and hooks from the next new conversation. */
/** Keep what the person has typed and not sent, for a conversation (its id) or for a new one (`new`). Empty text takes the draft away. Every window of the computer is told (`drafts`). */
export interface DraftCommand { cmd: "draft"; key: string; text: string }
/** Ask for the unsent drafts (answered with `drafts`). */
export interface DraftsCommand { cmd: "drafts" }
/** Ask for the tools the agent can use on this computer (answered with `tools`). */
export interface ToolsCommand { cmd: "tools" }
/** Switch one tool, or a whole set of tools (named by its id), on or off for the conversations that start afterwards. */
export interface ToolToggleCommand { cmd: "tool.toggle"; name: string; enabled: boolean }
/**
 * Starts the setup of a tool that says `needs-setup` (and has `setup: true`). `mode` is the permission mode of the conversation the person is in: in every mode but `bypass` the setup
 * stops at `ask` (what will be fetched, and how large) until `tool.setup.approve`; with no mode it asks. `tool.setup.cancel` stops it and keeps what was fetched for a later start.
 */
export interface ToolSetupCommand { cmd: "tool.setup"; id: string; mode?: PermMode }
export interface ToolSetupAnswerCommand { cmd: "tool.setup.approve" | "tool.setup.cancel"; id: string }
/** Choose where the Bash tool runs its commands, for the conversations that start afterwards. */
export interface TerminalUseCommand { cmd: "terminal.use"; backend: "local" | "docker" | "ssh" }
/** Confine commands on this computer or not, and let a confined command use the network or not: a field not given stays as it is. */
export interface SandboxUseCommand { cmd: "sandbox.use"; on?: boolean; network?: boolean }
/** Ask for the providers whose keys can be saved on this computer, and which have one (answered with `providers`). */
export interface ProvidersCommand { cmd: "providers" }
/** Save what a provider needs on this computer: its key (sent once, never sent back), the region, and the other fields it asks for. A key left out keeps the one already saved. */
export interface ProviderSaveCommand { cmd: "provider.save"; id: string; key?: string; region?: string; /** Another address for the provider (a gateway or proxy of the person): https, or http for this computer only; empty takes it away. It replaces the provider's own address, whatever region is chosen. */ base?: string; fields?: Record<string, string> }
/** Ask a provider, with what is saved for it, which models it has (answered with `provider.models`). */
export interface ProviderModelsCommand { cmd: "provider.models"; id: string }
/** Go on with one of the models of a provider, with what is saved for it: the conversation is handed over to it as for any other model. */
export interface ProviderUseCommand { cmd: "provider.use"; id: string; model: string }
/** One model of an endpoint the person made: its id as the server names it, and what the server does not say about it. */
export interface EndpointModel { id: string; window?: number; vision?: boolean; pdf?: boolean }
/** Ask for the endpoints the person made on this computer (answered with `endpoints`). */
export interface EndpointsCommand { cmd: "endpoints" }
/** Keep an endpoint: a server of the person's own (an address, how it is spoken, a key, the models to use). Without `id` a new one is made. No `key` keeps the saved key; an empty `key` removes it. */
export interface EndpointSaveCommand { cmd: "endpoint.save"; id?: string; name: string; baseUrl: string; /** `auto` (the default of the form): the server is asked in each style and the one that answers is saved, as that concrete value. */ api: "auto" | "chat" | "responses" | "messages" | "ollama"; key?: string; models: EndpointModel[] }
/** Take an endpoint away, with its key and every model made from it. */
export interface EndpointRemoveCommand { cmd: "endpoint.remove"; id: string }
/** Ask the server of an endpoint which models it has (answered with `endpoint.models`): a saved one by its `id`, or one not yet saved by what the form holds, which is also how it is tried. */
export type EndpointModelsCommand = { cmd: "endpoint.models"; id: string } | { cmd: "endpoint.models"; baseUrl: string; api: "auto" | "chat" | "responses" | "messages" | "ollama"; key?: string };
/** Ask what this computer can run a model with (answered with `machine`). */
export interface MachineCommand { cmd: "machine" }
/** Search the model hub for models that can be run here: GGUF files that match the words, each with where it runs on this computer at the context `window` (default 32768). A token for models that need a licence is the one saved for its provider. */
export interface LocalSearchCommand { cmd: "local.search"; query: string; window?: number }
/** The runtime that runs models here: its state (answered with `local.runtime`), fetching it, and stopping that (what was fetched is taken away). */
export interface LocalRuntimeCommand { cmd: "local.runtime" | "local.runtime.install" | "local.runtime.cancel" | "local.runtime.remove" }
/** A model file on this computer: fetched, paused, cancelled (what was fetched is taken away) or removed (with the file). Fetching goes on from where it stopped. `local.models` lists what is there and what is being fetched. */
export interface LocalFileCommand { cmd: "local.pull" | "local.pause" | "local.cancel" | "local.remove"; repo: string; file: string }
/** Run a model that is on this computer with the program's own model server (its context defaults to the largest that fits, up to 32768), or stop the one that runs. */
/** A short list of models to start with: small coding models that handle tools and fit this computer, best first (answered with `local.found` flagged `recommended`). */
export interface LocalRecommendedCommand { cmd: "local.recommended"; window?: number }
/** The accounts of this computer: the navvied account and the programs signed in to with a plan (answered with `accounts`). Nothing is signed in by asking. */
export interface AccountsCommand { cmd: "accounts" }
/** Install one of the programs with its official installer (progress is `account.install`, and `accounts` is said again at the end). */
/** Sign in to the navvied account by approving a code in the browser (the password never comes here): `account.login` starts it, `account.login.cancel` stops waiting, `account.logout` signs this computer out. */
export interface AccountLoginCommand { cmd: "account.login" | "account.login.cancel" | "account.logout" }
/**
 * Sign in to one of the programs with its own browser sign-in, which opens on this computer: `account.signin` starts it (`device`: a code to enter on another device instead),
 * `account.signin.code` gives the program a code its page showed, `account.signin.cancel` stops waiting. `account.signout` takes navvied's saved sign-in for the program away.
 */
export interface AccountSigninCommand { cmd: "account.signin"; id: string; device?: boolean }
export interface AccountSigninCodeCommand { cmd: "account.signin.code"; id: string; code: string }
export interface AccountSigninIdCommand { cmd: "account.signin.cancel" | "account.signout"; id: string }
/**
 * Sign in to a connected program that is reached over the web and asks for it (see `mcp.signin` in the events): `mcp.signin` starts it, `mcp.signin.cancel` stops waiting.
 * `mcp.prompts` asks for the ready-made requests the connected programs offer; `mcp.prompt` runs one as the person's own request, with its arguments filled in.
 */
export interface McpSigninCommand { cmd: "mcp.signin" | "mcp.signin.cancel"; server: string }
export interface McpPromptsCommand { cmd: "mcp.prompts" }
export interface McpPromptCommand { cmd: "mcp.prompt"; server: string; name: string; args?: Record<string, string> }
export interface AccountInstallCommand { cmd: "account.install"; id: string }
export interface LocalRunCommand { cmd: "local.run"; repo: string; file: string; window?: number }
export interface LocalStopCommand { cmd: "local.stop" }
export interface LocalModelsCommand { cmd: "local.models" }
/** Ollama on this computer, when the person has it: ask what it is (`local.ollama`), fetch a model by the name Ollama knows it by, or stop that (Ollama takes up what was fetched at the next pull). */
export interface LocalOllamaCommand { cmd: "local.ollama" }
export interface LocalOllamaPullCommand { cmd: "local.ollama.pull" | "local.ollama.cancel"; model: string }
export interface ProviderRemoveCommand { cmd: "provider.remove"; id: string }
export interface PluginToggleCommand { cmd: "plugin.toggle"; id: string; enabled: boolean }
/** Notes the agent wanted to keep after reading text from the web wait for the person (`caps.memory`). Without `action` it lists them (answered with `memory.pending`); `accept` keeps one (marked as from the web), `reject` drops it. */
export interface MemoryPendingCommand { cmd: "memory.pending"; action?: "accept" | "reject"; id?: string }
/** What waits for the person among skills (`caps.skillReview`): changes the agent made with approval set to `ask`, and project skills not yet accepted. Without `id` it lists (answered with `skill.review`); with `id` and `accept` it answers one (a trust item has the id `trust:<name>`). */
export interface SkillReviewCommand { cmd: "skill.review"; id?: string; accept?: boolean }
/** Undo a change the agent made to a skill: the one named by `id`, or the latest. Answered with `skill.review`. */
export interface SkillRollbackCommand { cmd: "skill.rollback"; id?: string }
/** Ask for the files conversations wrote (of one conversation, with `id`; answered with `artifacts`). */
export interface ArtifactsCommand { cmd: "artifacts"; id?: string }
/** Read one file to show it: text or a picture. A file is named by the `id` the hub gave; a path is never taken. Answered with `artifact`. */
export interface ArtifactReadCommand { cmd: "artifact.read"; id: string }
/**
 * Fetch the bytes of a picture, a sound or a video a step made, to show or play it on a page that is not on this computer. A file is named by the `media.id` a `tool` event gave (`media`); a path is never taken. Answered to the asker only, as one or more `media`
 * events: `offset` and `length` (default and most: 262144) are in bytes of the file, so a page asks again from `offset + length` until `done`. At most 64 MB for one file.
 */
export interface MediaReadCommand { cmd: "media.read"; id: string; offset?: number; length?: number }
/** Ask for the agents this computer may ask and the agents that may ask it (answered with `a2a`). */
export interface A2aListCommand { cmd: "a2a.list" }
/**
 * Keep an agent this computer may ask (the same as an entry of `a2a.peers` in the configuration file). `token` is what that agent gave for it: it is sent once, kept in a private file of this computer and never sent back (`tokenEnv` and `tokenFile` name
 * where a token already is instead). From the next new conversation on. Answered with `a2a`.
 */
export interface A2aPeerAddCommand { cmd: "a2a.peer.add"; name: string; url: string; token?: string; tokenEnv?: string; tokenFile?: string; timeoutSeconds?: number }
/** Stop asking one agent, and take away the token file this computer made for it. Answered with `a2a`. */
export interface A2aPeerRemoveCommand { cmd: "a2a.peer.remove"; name: string }
/** Make the token for an agent that may ask this computer (`navvied a2a add`). Answered to the asker only with `a2a.token`, the one time it can be read, and to every window with `a2a`. */
export interface A2aTokenAddCommand { cmd: "a2a.token.add"; name: string }
/** Take a token back (`navvied a2a revoke`). Answered with `a2a`. */
export interface A2aTokenRevokeCommand { cmd: "a2a.token.revoke"; name: string }
/** Ask for the notes the agent kept (the same ones as the Remember tool and `/memory`), of one place or both (answered with `memory.notes`). */
export interface MemoryListCommand { cmd: "memory.list"; scope?: "project" | "user" }
/** Change one note, by the `id` of `memory.notes`: the same checks as the Remember tool (no secrets, at most 500 characters, no repeat). Answered with a `notice` or an `error` and the updated `memory.notes`. */
export interface MemoryEditCommand { cmd: "memory.edit"; id: string; scope: "project" | "user"; text: string }
/** Forget one note. Answered like `memory.edit`. */
export interface MemoryForgetCommand { cmd: "memory.forget"; id: string; scope: "project" | "user" }
export type MemoryExtract = "off" | "rules" | "model";
/** Whether the agent looks through what the person said for lasting facts (`memory.extract` of the configuration): without `mode` it is only asked; answered with `memory.extract`. From the next new conversation on. */
export interface MemoryExtractCommand { cmd: "memory.extract"; mode?: MemoryExtract }
/** The documents (resources) the connected programs offer, of one program or all (answered with `mcp.resources`). */
export interface McpResourcesCommand { cmd: "mcp.resources"; server?: string }
/** Read one document of a connected program (answered with `mcp.resource`). */
export interface McpResourceCommand { cmd: "mcp.resource"; server: string; uri: string }
/** Look for tools of the connected programs by words, as the model does when they are too many to list (answered with `mcp.tools`). Nothing is offered to the model by it. Without `query` it lists them, the first 50. */
export interface McpToolsCommand { cmd: "mcp.tools"; query?: string; server?: string }
/**
 * Install a plugin from a folder or archive on this computer, or from an address (a `.zip`, `.tar.gz` or git address). Without `fingerprint` nothing is installed: the answer is `plugin.install` with `state: "ask"`, what the plugin brings and every command it would run.
 * With the `hash` of that answer as `fingerprint` it is installed (off, as `navvied plugin install` does) and the answer is `state: "done"`, then `plugins`. Not offered by a cloud session.
 */
export interface PluginInstallCommand { cmd: "plugin.install"; from: string; fingerprint?: string }
/** The person takes the screen from the agent, or gives it back (answered with `computer.state`, whose `control` says who has it). The agent's steps are refused with `human_has_control` while the person has it. */
export interface ComputerControlCommand { cmd: "computer.takeover" | "computer.giveback" }
/** Give a saved conversation another title. Answered with the updated `sessions` event. */
export interface RenameCommand { cmd: "rename"; id: string; title: string }
/** Delete a saved conversation (here and on the account). Deleting the one in use starts a new one. */
export interface RemoveCommand { cmd: "remove"; id: string }
/** Keep a conversation at the top of the list, or let it go back to its place. */
export interface PinCommand { cmd: "pin"; id: string; pinned: boolean }
export interface RestoreCommand { cmd: "restore"; id: string; preview?: boolean }

/** Every command may say which kind of conversation it is for. */
export type Command = (McpSigninCommand | McpPromptsCommand | McpPromptCommand | ProvidersCommand | LocalRunCommand | LocalStopCommand | LocalFileCommand | LocalModelsCommand | AccountsCommand | AccountSigninCommand | AccountSigninCodeCommand | AccountSigninIdCommand | AccountLoginCommand | AccountInstallCommand | LocalRecommendedCommand | LocalOllamaCommand | LocalOllamaPullCommand | LocalRuntimeCommand | LocalSearchCommand | MachineCommand | EndpointsCommand | EndpointSaveCommand | EndpointRemoveCommand | EndpointModelsCommand | ProviderModelsCommand | ProviderUseCommand | ProviderSaveCommand | ProviderRemoveCommand | PromptCommand | CancelCommand | ApproveCommand | AnswerCommand | CompactCommand | ModelCommand | EffortCommand | LoadCommand | SessionsCommand | SearchCommand | CheckpointsCommand | RestoreCommand | JobStopCommand | NewCommand | RenameCommand | RemoveCommand | PinCommand | ImportCommand | TransferCommand | ForkCommand | ArchiveCommand | MarkCommand | ReceiveCommand | SchedulesCommand | ScheduleAddCommand | ScheduleUpdateCommand | ScheduleRemoveCommand | ScheduleRunCommand | ScheduleRunsCommand | ComputerStateCommand | ComputerPermissionCommand | ComputerOnCommand | PluginsCommand | PluginToggleCommand | DraftCommand | DraftsCommand | ToolsCommand | ToolToggleCommand | ToolSetupCommand | ToolSetupAnswerCommand | TerminalUseCommand | SandboxUseCommand | ArtifactsCommand | ArtifactReadCommand | MemoryPendingCommand | SkillReviewCommand | SkillRollbackCommand | MediaReadCommand | A2aListCommand | A2aPeerAddCommand | A2aPeerRemoveCommand | A2aTokenAddCommand | A2aTokenRevokeCommand | MemoryListCommand | MemoryEditCommand | MemoryForgetCommand | MemoryExtractCommand | McpResourcesCommand | McpResourceCommand | McpToolsCommand | PluginInstallCommand | ComputerControlCommand) & { kind?: SessionKind };
/** What this computer is, as far as it could be read: a card or a number that could not be read is not there, never a guess. */
export interface MachineInfo {
  os: "linux" | "wsl" | "macos" | "windows" | "unknown";
  arch: "x64" | "arm64" | "unknown";
  gpus: { name: string; vendor: "nvidia" | "amd" | "intel" | "apple" | "unknown"; kind: "discrete" | "integrated" | "unified" | "unknown"; memoryMb?: number; freeMb?: number; driver?: string }[];
  ramMb: number;
  freeRamMb?: number;
  disk?: { path: string; freeMb: number; totalMb: number };
}
/** One model file the hub offers: `fit` says where it runs on this computer (`gpu`: all in the card, `ram`: it needs the computer\'s memory, `none`: neither has room), absent when the file\'s header could not be read. */
export interface LocalFile { repo: string; /** The page of the model on the hub: where a licence is read and accepted by the person, never for them. */ page: string; file: string; quant: string; sizeMb: number; parts: number; gated: boolean; /** Whether the chat template of the model handles tools (a model that does not can only talk in the agent): left out when it is not known. */ tools?: boolean; fit?: "gpu" | "ram" | "none"; needMb?: number; gpuLayers?: number; window?: number }
/** One account as the page shows it: `installed`, `version` and `signedIn` are what the program itself says (`signedIn` only when it is installed); `email` and `plan` only when it says them. */
export interface AccountInfo { /** `navvied`, or the id of a program of the list the engine keeps. */ id: string; installed?: boolean; version?: string; signedIn?: boolean; email?: string; plan?: string }
/** A ready-made request a connected program offers, with the arguments it takes. */
export interface McpPromptInfo { server: string; name: string; description?: string; arguments?: { name: string; description?: string; required?: true }[] }
export interface EndpointSaved { id: string; name: string; baseUrl: string; api: "chat" | "responses" | "messages" | "ollama"; /** Whether a key is saved: it is never sent back. */ key: boolean; models: EndpointModel[] }
export interface ProviderSaved { id: string; key: boolean; /** The address the person set instead of the provider's own. */ base?: string; /** A provider that signs in with a credential file of the computer: whether one was found now (its path and contents are never said). */ credential?: boolean; region?: string; fields?: Record<string, string> }
export type CommandName = Command["cmd"];

/* ── engine → front-end ─────────────────────────────────────────────────────────────────────────────────────── */

/** A saved session as a list shows it. `updated` is in ms since the epoch. */
export interface SessionInfo { /** Absent: `agent`. */ kind?: SessionKind; /** A reply is being written for it right now, on this computer (in front, or in the background). */ running?: true; /** A turn ended while no window was looking, and nobody has opened it since. */ unread?: true; /** Marked complete by the person. */ done?: true; /** Archived (only in the archived list). */ archived?: true; /** Where it is kept: on this computer, or in the cloud (the account). Absent: this computer. */ where?: "this" | "cloud"; /** Kept at the top of the list. */ pinned?: true; id: string; title: string; updated: number; messages: number; /** Where it took place when that is not this computer: the name of another computer, or "hosted". */ source?: string; /** The folder it was about (its name only), so a list can be grouped by project. */ project?: string }

/** A file a conversation wrote. `path` is for showing on the same machine only. */
export interface ArtifactInfo { id: string; conversation: string; name: string; bytes: number; updated: number; mime: string; path?: string }

/** Something that extends the agent. `fromNext`: a change reaches the next new conversation. */
/** One tool of the agent, in plain words. `access` says what it can do to the computer; `core` tools are what coding is made of; `small` says a small model is offered it without asking. */
export interface ToolInfo { name: string; title: string; about: string; access: "read" | "change" | "run" | "web"; enabled: boolean; core: boolean; small: boolean; /** How many times the agent used it on this computer. */ calls: number; /** The id of the set it belongs to. */ set: string }
/** Why a tool is or is not usable: `on` and `off` are the person's switch; `needs-setup` is on but waits for something the person must connect; `soon` is a tool that does not exist yet; `unavailable-here` is one that exists but cannot run in this place (the cloud); `experimental` is off until the person switches it on. */
export type ToolState = "on" | "off" | "needs-setup" | "soon" | "unavailable-here" | "experimental";
/** One of the categories the tools are shown under. */
export interface ToolCategory { id: string; title: string }
/** One tool as the person knows it, with its own switch. `names` are the engine's tools it stands for; `category` is the id of one of the categories. */
export interface ToolEntry { id: string; category: string; names: string[]; title: string; about: string; on: boolean; state: ToolState; /** Present only for a tool that has a setup to start (`tool.setup`). */ setup?: true; /** How many times the agent used it on this computer. */ calls: number }
/** Tools that belong together, shown as one card: what they are for, how many there are, and how often they were used. */
export interface ToolSetInfo { id: string; title: string; about: string; tools: string[]; enabled: boolean; calls: number }
/** One place the Bash tool can run commands: `ready` says it can be used now, `hint` says what to do when it cannot. */
export interface BackendInfo { id: "local" | "docker" | "ssh"; label: string; about: string; ready: boolean; using: boolean; hint?: string }
/** Whether commands on this computer are confined (`on`), whether a confined command may use the network, and what confines them here: `how` is `none` when this computer cannot (`why` says so, in a few plain words). */
export interface SandboxInfo { on: boolean; network: boolean; how: "bubblewrap" | "seatbelt" | "jobobject" | "none"; why?: string }
export interface PluginInfo {
  id: string;
  kind: "skill" | "mcp" | "hook" | "plugin";
  name: string;
  description: string;
  enabled: boolean;
  source: "user" | "project" | "config";
  fromNext?: true;
  /** A `plugin` only: its version, where it was installed from (a folder, an archive or an address, never with a password), the sha-256 of its files, what it brings, and every command it would run with its source. */
  version?: string;
  origin?: string;
  hash?: string;
  brings?: { skills: string[]; agents: string[]; commands: string[]; hooks: number; mcp: string[] };
  runs?: { what: string; command: string; source: string; findings?: string[] }[];
  /** A project plugin is not used until the person accepts it (`skill.review`, item `trust:plugin:<name>`); the person's own plugins are always trusted. */
  trusted?: boolean;
  /** What a scan of the text it hands to the model found, in words (each names its file); empty or missing when nothing. */
  findings?: string[];
  /** Why it cannot be used (damaged, changed since it was installed, not as its manifest says). */
  problem?: string;
}

/** A scheduled task as a list shows it. Times are ms since the epoch. */
export interface ScheduleInfo { id: string; title: string; prompt: string; /** The timing in a few words (the cron, `every 15m`, `once 2026-12-01 09:00 UTC`); a screen reads `when`, not this. */ cron: string; /** The timing in the shape `schedule.add` takes. */ when: ScheduleWhen; /** The time zone it is in, when one was given. */ tz?: string; /** When it runs next (none while turned off). */ next?: number; last?: number; /** How the last run ended: 0 is fine. */ lastCode?: number | null; enabled: boolean; folder?: { id: string; name: string }; kind: SessionKind; mode: "plan" | "auto"; running?: true; /** The most recent due time that nothing ran at (the computer was off or the app closed); gone after the next run. */ missed?: ScheduleMiss }
/** `off`: the computer was off or the program was not running at the due time. A client treats a reason it does not know like `off`. */
export interface ScheduleMiss { at: number; reason: "off" }
/** One run of a task: `fine`, `failed`, `stopped` (cancelled, or it took too long), `running` or, for a cloud job, `missed`. `due` is only there when it started late. `said` is a short text of what it said, with secrets hidden (at most 200 characters). */
export interface ScheduleRunInfo { at: number; outcome: "fine" | "failed" | "stopped" | "running" | "missed"; due?: number; said?: string }

/** A conversation that mentions what was searched for. */
/** A conversation that mentions what was searched for. `where` and `project` are as in the list; a title found in the cloud has an empty `snippet`. */
export interface SearchHit { id: string; title: string; snippet: string; updated: number; where?: "cloud"; project?: string }

/** One step of a loaded conversation: what the person said, what the model answered, or the name of a tool it used. */
export interface HistoryItem { k: "user" | "assistant" | "tool"; text: string; /** Only on what the person said, and only when it was said in this program: the id the message was sent with, so a window that has the message already (its own bubble, or the live event) recognises it. */ qid?: string }

/** One model a person can switch to. A page shows `name`, never a real model id. */
export interface ModelInfo {
  id: string;
  name: string;
  /** The family it belongs to, when the engine groups its models (for a page that shows tabs). */
  brand?: string;
  /** A short label such as FAST or MAX. */
  badge?: string;
  /** One line saying what it is good for. */
  blurb?: string;
  /** Shown but not usable now, such as a model that needs a plan. */
  locked?: boolean;
  /** The one in use. */
  current?: boolean;
  /** For a model of navvied.com's own catalogue (the free ones a computer may use, or the ones of the account): the id that model has in the catalogue the site lists (`/api/hosted/status`), whatever name this engine gives the entry. Left out for every other model. A page matches by this and never by the shape of `id`. */
  catalog?: string;
  /** Set on a model of the other kind than the one running (a program beside navvied's models, or the reverse): choosing it hands the conversation over, and the hub says so itself with a `notice`. Absent for a model the engine switches to on its own. */
  handover?: true;
  /** Whether this model takes file attachments from whoever is asking. Left out means yes. */
  files?: boolean;
  /** Whether the model handles tools, read from its own chat template; left out when that is not known. A model that does not can only talk. */
  tools?: boolean;
  /** An administrator has turned this model off. Shown to everyone, dimmed and not clickable, except to an administrator, who may still pick it. Left out means on. */
  enabled?: boolean;
  /** Who reaches it: a short id the models file gives each backend (the local computer is one), so the picker can group models into sections. Never a vendor's own name: that only ever lives in the deployed, never-committed models file. */
  provider?: string;
}

export type ToolStatus = "running" | "done" | "error";
export type StopReason = "end_turn" | "cancelled" | "compacted" | "error" | (string & {});

export interface ApprovalOption {
  optionId: string;
  name: string;
  kind?: "allow_once" | "allow_always" | "reject_once" | "reject_always" | (string & {});
  /** The person may change this text before choosing the option (the command to run); the change is sent as `approve.input` and is checked again. A front-end that cannot edit leaves the option out. */
  editable?: { value: string };
}
/** Why a tool did not do its work, when that is not a plain failure. */
export type ToolOutcome = "denied" | "blocked" | "timeout" | "stopped" | "skipped" | "background" | "redirected";

/** How a step on the screen ended, for a card that says it in words: `code` is a refusal's closed reason (the helper's, or `stale_target` from the engine), `which` what is missing, `app` the application it was about, `next` the exact next step. No capture or picture is ever in it. */
export interface ScreenOutcome { verdict: "delivered" | "unverified" | "refused"; code?: string; which?: string; app?: string; next?: string }

/** What a consent to use the screen is about: the application, what it is for (`capture`: look at its window; `input`: click, type or press keys in it; `foreground`: bring it in front of the person), and the lines of what the agent is about to do there (each an action as the model wrote it, such as `click 12` or `type: Hello`; secrets hidden, each at most 200 characters, at most 8). The options of the `approval` are the usual three; "do not ask again" holds for this application only. */
export interface ScreenAsk { app: string; about: "capture" | "input" | "foreground"; lines: string[] }
/** The two grants an operating system asks for before a program may use the screen. `not-needed`: this system has no such grant. */
export type ComputerPermissionId = "accessibility" | "screen-recording";
export interface ComputerPermission { id: ComputerPermissionId; state: "granted" | "missing" | "not-needed" }
/**
 * Where turning on computer use stands. `install`: the driver is not on this computer (its fetch is told with `tool.setup`, id `computer`). `permissions`: it is, and a grant is `missing`.
 * `ready`: nothing is missing, so it can be switched on (`computer.on`). `unavailable`: this place cannot do it (a cloud session, an unsupported system, no desktop app); `reason` says why.
 */
export interface ComputerState { on: boolean; step: "install" | "permissions" | "ready" | "unavailable"; permissions: ComputerPermission[]; reason?: string; /** Who has the screen while it is on: `agent` (the default) or `person`, who took it with `computer.takeover` and gives it back with `computer.giveback`. */ control?: "agent" | "person" }

/** One step of a tool's setup. `waiting`: not started (or stopped by `tool.setup.cancel`); `active`: being worked on (`bytes` of `total`, in bytes, are its own); `done`; `failed`: the step the setup stopped at (`error` of the event says why). */
export interface SetupStep { name: string; state: "waiting" | "active" | "done" | "failed"; bytes: number; total: number }
/** A picture, a sound or a video a step made, as a page can fetch it (`media.read`). `id` is good for this program run only; `seconds` is the length of a sound or a video when it is known. */
export interface MediaRef { id: string; kind: "image" | "audio" | "video"; mime: string; bytes: number; name: string; width?: number; height?: number; seconds?: number }
/** An agent this computer may ask: where it is, and whether a token is set for it (never the token). */
export interface A2aPeerInfo { name: string; url: string; token: boolean; timeoutSeconds?: number }
/** A token of an agent that may ask this computer, as a list shows it (never the token itself). Times are ms since the epoch. */
export interface A2aTokenInfo { name: string; createdAt: number; lastUsed?: number }
/** One note the agent kept. `text` is as it is put in front of the model: a note that fails the scan for secrets is `[hidden: …]`. */
export interface MemoryNote { id: string; scope: "project" | "user"; date: string; text: string; origin: "user" | "self" | "web" }
/** A document a connected program offers; a `template` has `{parts}` to fill in the `uri`. */
export interface McpResourceInfo { server: string; uri: string; name?: string; description?: string; mimeType?: string; template?: true }
/** A tool of a connected program: `name` is how the model calls it, `tool` how the program names it, `signature` what a call needs. */
export interface McpToolFound { server: string; name: string; tool: string; description: string; signature: string }
/** One part of a document that was read: text (cut at 1 MB, then `truncated`) or `data` (base64, at most 2 MB; a larger one has only `bytes`). */
export interface McpResourceContent { uri?: string; mime?: string; bytes: number; text?: string; data?: string; truncated?: true }
/** What a hook decided about a step: `allowed` (it said yes; the mode and the rules still decide), `blocked`, `asked` (the person must say yes first), `changed` (it changed the input) or `added` (it gave the model more to read). */
export type HookDecision = "allowed" | "blocked" | "asked" | "changed" | "added";
/** What the Browser tool saw happen, as data (`what` names the kind): a dialog opened or answered, a download, a file the page asks for, a number that no longer stands for anything. */
export type BrowserNote =
  | { what: "dialog"; state: "opened"; type: string; message: string; defaultPrompt?: string }
  | { what: "dialog"; state: "answered"; type: string; accepted: boolean }
  | { what: "download"; state: "started" | "done" | "failed"; name: string; bytes?: number; path?: string; note?: string }
  | { what: "upload"; state: "asked" }
  | { what: "upload"; state: "done"; name: string; bytes: number }
  | { what: "ref"; state: "expired"; ref?: number; why: "page-changed" | "gone" | "unknown" | "unnumbered" };
/** A picture a tool saved as a file: where it is, its size in bytes, its width and height in pixels, and its type (`image/jpeg`, `image/png`, `image/webp`). */
export interface PictureInfo { path: string; bytes: number; width: number; height: number; mime: string }
/** What a turn has used so far (or in all): tokens sent to the model (`in`, every call counted), tokens it wrote (`out`), and how many times the model was called. */
export interface TurnTokens { in: number; out: number; calls: number }
/** What an action would change, so a page can show it next to the question. Long text is cut and `truncated` is set. */
export type ApprovalChange =
  | { tool: "Edit"; file: string; old: string; new: string; truncated?: true }
  | { tool: "Write"; file: string; content: string; truncated?: true }
  | { tool: "Bash"; command: string; truncated?: true };
/** `activeForm` is the title in the present tense ("Running the tests"), shown while the entry is in progress. */
export interface PlanEntry { title: string; status: "pending" | "in_progress" | "completed" | (string & {}); activeForm?: string }
/** One question the agent asks the person. `choices` are at most four short answers, the recommended one first; the person may always answer in their own words. */
export interface QuestionItem { question: string; choices?: string[]; /** More than one choice may be picked. */ multi?: true }

/** What this engine can do — front-ends show controls only for what is real. */
export interface Capabilities {
  /** A message sent mid-turn is folded into the running turn. */
  steer: boolean;
  /** Permission modes the engine supports (empty: none). */
  modes: PermMode[];
  defaultMode?: PermMode;
  /** The `compact` command works. */
  compact: boolean;
  /** `checkpoints` and `restore` work. */
  checkpoints?: boolean;
  /** What this engine is for (absent: `agent`). */
  kind?: SessionKind;
  /** The hub can start a new conversation, rename, delete and pin saved ones (`new`, `rename`, `remove`, `pin`). */
  manage?: true;
  /** The folders this computer offers an agent to work in (`new` names one by `id`). Absent for a chat. `path` is for showing on the same machine only. */
  folders?: { id: string; name: string; path?: string; last?: number; current?: true }[];
  /** The hub can also fork, archive and mark conversations (`fork`, `archive`, `mark`). */
  rowActions?: true;
  /** The hub keeps and runs scheduled tasks (`schedules`, `schedule.*`). */
  schedule?: true;
  /** The hub lists skills, tool servers and hooks and can switch them (`plugins`, `plugin.toggle`). */
  plugins?: true;
  /** The hub keeps notes the agent wanted to save from web text for the person to accept (`memory.pending`). */
  memory?: true;
  /** The hub keeps skill changes and project skills for the person to accept, and can undo a change (`skill.review`, `skill.rollback`). */
  skillReview?: true;
  /** The hub lists the agent's tools and can switch them (`tools` command, `tool.toggle`). */
  toolList?: true;
  /** The hub keeps unsent text for every window (`draft`, `drafts`). */
  drafts?: true;
  /** The hub keeps the files conversations wrote and can show them (`artifacts`, `artifact.read`). */
  artifacts?: true;
  /** What a person should know about when scheduled tasks run. */
  scheduleNote?: string;
}

export interface CheckpointInfo { id: string; at: number; label: string; repos: string[] }
/** How restoring treats one file: `revert` an edit, `recreate` a deleted file, `remove` a file created since. */
export type RestoreChange = "revert" | "recreate" | "remove";
export interface RestoreEntry { repo: string; path: string; change: RestoreChange }

/** Every event may say which kind of conversation it belongs to (absent: `agent`). */
export type EngineEvent = EngineEventBody & { kind?: SessionKind };
type EngineEventBody =
  | { ev: "session"; id: string }
  /** Sent by a hub as the last line of what a window that just attached had missed (also when that was nothing): the window is now up to date. It has no `kind` and no sequence of its own. */
  /** `count` conversations of hosted sessions were moved from the account onto this computer. */
  | { ev: "imported"; count: number }
  /** The scheduled tasks (sent when asked and whenever one changes or finishes a run). */
  | { ev: "schedules"; items: ScheduleInfo[] }
  /** The newest runs of one task, newest first (answer to `schedule.runs`, also for a cloud job). */
  | { ev: "schedule.runs"; id: string; runs: ScheduleRunInfo[] }
  /** Where turning on computer use stands (answer to `computer.state`, `computer.permission` and `computer.on`; sent again whenever a grant or the switch changes). */
  | ({ ev: "computer.state" } & ComputerState)
  /** The things that extend the agent here (sent when asked and when one is switched). */
  | { ev: "plugins"; items: PluginInfo[] }
  /** The notes waiting for the person: `count` is how many, and each says where the suggestion came from (`source`: the person's own message, a file, a web page, or a tool's result; `n` the message of the conversation it was taken from, 1-based, when it came from one). */
  | { ev: "memory.pending"; count: number; items: { id: string; scope: "project" | "user"; action: "add" | "replace" | "forget"; text: string; target?: string; origin: "user" | "self" | "web"; source: "message" | "file" | "web" | "tool"; n?: number; at: number }[] }
  | { ev: "skill.review"; items: { id: string; kind: "change" | "trust"; name: string; summary: string; findings?: string[] }[]; history: { id: string; name: string; action: "create" | "patch" | "delete"; actor: "agent" | "person"; at: number; state: "applied" | "waiting" | "rejected" | "undone" }[] }
  /** The providers of this computer that have something saved (sent when asked and whenever one is saved or removed). Never carries a key: `key` says only that one is saved, and `fields` holds the values of the fields that are not secret. */
  | { ev: "providers"; items: ProviderSaved[] }
  /** The models a provider lists, as it names them (the answer to `provider.models`). */
  /** The endpoints the person made on this computer (sent when asked and whenever one is saved or removed). */
  | { ev: "endpoints"; items: EndpointSaved[] }
  /** The answer to `machine`. */
  | ({ ev: "machine" } & MachineInfo)
  /** The answer to `local.search`: files that match, those that run best here first; `notes` says what was left out and why (a rate limit, a repository that could not be read). */
  | { ev: "local.found"; items: LocalFile[]; notes?: string[]; /** The answer to `local.recommended`, not to a search. */ recommended?: true }
  /** The state of the runtime that runs models here: `none` (not fetched), `installing` (`file`, `bytes` of `total`), `verifying`, `failed` (`error`, in words), `ready` (`backend`: the build for this computer's card or processor). `version` is the release it is pinned to. */
  /** The state of one model file: `downloading` (`bytes` of `total`), `paused`, `nodisk` (`error` says how much is needed), `failed`, `done`, `running` (the program's own model server runs it) or `idle` (nothing of it is here). */
  | { ev: "local.file"; repo: string; file: string; state: "idle" | "downloading" | "paused" | "nodisk" | "done" | "running" | "failed"; bytes?: number; total?: number; error?: string }
  /** The model files on this computer and the ones being fetched. */
  | { ev: "local.installed"; items: { repo: string; file: string; quant: string; sizeMb: number; /** Whether the chat template inside the file handles tools: left out when the file does not say. */ tools?: boolean; state: "done" | "running" | "downloading" | "paused" | "nodisk" | "failed"; bytes?: number; total?: number; error?: string }[] }
  /** The model server of this computer: `starting`, `running` (`window` is the context it was started with, `layers` how many went to the card), `stopped`, or `failed` (`error`, in words). One model runs at a time; while it runs its model is in the list of models. */
  /** Ollama on this computer: `missing` (it does not answer), or `ready` with the address it listens on, its version and the models it keeps. */
  | { ev: "local.ollama"; state: "missing" | "ready"; baseUrl?: string; version?: string; models?: { name: string; /** Whether Ollama says the model takes tools (its `capabilities`): left out when it does not say. */ tools?: boolean }[] }
  /** One model being fetched through Ollama: `downloading` (`bytes` of `total`, summed over its layers), `verifying`, `done` (it is in Ollama's list), `failed` (`error`, in words) or `idle` (stopped). */
  | { ev: "local.ollama.model"; model: string; state: "downloading" | "verifying" | "done" | "failed" | "idle"; bytes?: number; total?: number; error?: string }
  /** The answer to `accounts`. */
  | { ev: "accounts"; items: AccountInfo[] }
  /** The sign-in of the navvied account by a link: `waiting` (`url` to open, the `code` it must show, `expires` as a time in milliseconds), then `done` (`email`), `denied`, `expired`, `failed` (`error` in words) or `stopped`. `accounts` follows `done`. */
  | { ev: "account.login"; state: "waiting" | "done" | "denied" | "expired" | "failed" | "stopped"; url?: string; code?: string; expires?: number; email?: string; error?: string }
  /** The sign-in of a program: `waiting` (`url` to open, and for a device sign-in the `code` to enter there), then `done`, `failed` (`error` in words) or `stopped`. `accounts` follows `done`. */
  | { ev: "account.signin"; id: string; state: "waiting" | "done" | "failed" | "stopped"; url?: string; code?: string; error?: string }
  /** The sign-in of a connected program on the web, by its name in the configuration. `needed`: it asked for one when it was connected. `waiting`: `url` is the page to open, which comes back to this computer by itself (`code` only for a sign-in that shows a code to enter elsewhere). Then `done`, `failed` (`reason` in words) or `stopped`. A conversation started after `done` connects the program by itself. */
  | { ev: "mcp.signin"; server: string; state: "needed" | "waiting" | "done" | "failed" | "stopped"; url?: string; code?: string; reason?: string }
  /** The answer to `mcp.prompts`. */
  | { ev: "mcp.prompts"; items: McpPromptInfo[] }
  /** A piece of a file a step made, the answer of `media.read` (to the asker only; not kept for a window that arrives later). `data` is base64 of the bytes from `offset` on; `done` is set on the last piece. */
  | { ev: "media"; id: string; mime: string; bytes: number; offset: number; data: string; done: boolean }
  /** The agents this computer may ask and the agents that may ask it, with the seconds a token takes to reach the relay (a token added or revoked is looked at again that often). */
  | { ev: "a2a"; peers: A2aPeerInfo[]; tokens: A2aTokenInfo[]; syncSeconds: number }
  /** The token a `a2a.token.add` made. Sent to the one who asked, once; it is not kept, and no other event, list or window carries it. */
  | { ev: "a2a.token"; name: string; token: string }
  /** The notes the agent kept, newest last in each place. */
  | { ev: "memory.notes"; items: MemoryNote[] }
  /** Whether the agent looks through what the person said for lasting facts. */
  | { ev: "memory.extract"; mode: MemoryExtract }
  /** The answer to `mcp.resources`; a program that could not list its documents is in `problems`. */
  | { ev: "mcp.resources"; items: McpResourceInfo[]; problems?: { server: string; reason: string }[] }
  /** The answer to `mcp.resource`. */
  | { ev: "mcp.resource"; server: string; uri: string; contents: McpResourceContent[] }
  /** The answer to `mcp.tools`: the best matches (at most 50), and how many tools the connected programs have. */
  | { ev: "mcp.tools"; query: string; items: McpToolFound[]; total: number }
  /** A hook decided something. `step` is the `tool` event it was about (absent for a hook of the message or of the end of the turn), `hook` its command and `source` where it comes from (`plugin:name`; absent for the person's own). */
  | { ev: "hook"; event: string; decision: HookDecision; hook: string; source?: string; step?: string; tool?: string; reason?: string }
  /** The answer to `plugin.install`: `ask` (what it brings and every command it would run, fingerprint in `hash`), `done` or `failed` (`error` says why). */
  | { ev: "plugin.install"; state: "ask" | "done" | "failed"; from: string; name?: string; version?: string; description?: string; hash?: string; brings?: { skills: string[]; agents: string[]; commands: string[]; hooks: number; mcp: string[] }; runs?: { what: string; command: string; source: string; findings?: string[] }[]; findings?: string[]; error?: string }
  /** What the Browser tool saw happen in a step (see `BrowserNote`); `tool` is the step. */
  | ({ ev: "browser"; tool?: string } & BrowserNote)
  /** The installation of a program: `installing`, then `done` or `failed` (`error` in words). */
  | { ev: "account.install"; id: string; state: "installing" | "done" | "failed"; error?: string }
  | { ev: "local.server"; state: "starting" | "running" | "stopped" | "failed"; repo?: string; file?: string; window?: number; layers?: number; error?: string }
  /** The setup of a tool on this computer (`tool.setup`). `ask`: what will be fetched (`files`, `totalMb`), waiting for `tool.setup.approve`. `downloading`/`verifying`/`installing`: `file`, and `bytes` of `total` over everything. `unavailable`: not possible on this computer, `error` says why. `idle`: stopped by `tool.setup.cancel`. */
  | { ev: "tool.setup"; id: string; state: "ask" | "downloading" | "verifying" | "installing" | "done" | "failed" | "unavailable" | "idle"; files?: { name: string; sizeMb: number }[]; totalMb?: number; file?: string; bytes?: number; total?: number; error?: string; /** Every step of the setup in the order it is worked on, with where each stands (sent with `ask`, the progress states, `done`, `failed` and `idle`). */ steps?: SetupStep[]; /** How far the whole setup is, 0 to 100 (the same as `bytes` of `total`). */ percent?: number }
  | { ev: "local.runtime"; server: "running" | "stopped"; state: "none" | "installing" | "verifying" | "failed" | "ready"; version: string; backend?: string; file?: string; bytes?: number; total?: number; error?: string }
  /** The models the server of an endpoint lists (the answer to `endpoint.models`), with the context size when the server says it (an empty window of a model means the engine finds it). */
  | { ev: "endpoint.models"; /** The way the server is spoken: the one asked for, or the one found when it was `auto`. */ api: "chat" | "responses" | "messages" | "ollama"; items: { id: string; window?: number }[] }
  | { ev: "provider.models"; id: string; models: string[]; /** Models the provider lists that this program cannot reach (a protocol it does not speak), each with the reason. */ skipped?: { id: string; reason: string }[] }
  /** A message was received and is waiting its turn (the agent is busy, or still starting): every window shows it as waiting, not only the one that sent it. It is followed by `user` and `taken` when the agent takes it. */
  | { ev: "queued"; qid: string; text: string; images?: number; files?: FileNote[] }
  /** Waiting messages that were thrown away without being taken (the person stopped the agent, or it failed): windows take them off the screen. */
  | { ev: "dropped"; qids: string[] }
  | { ev: "tools"; items: ToolInfo[]; sets: ToolSetInfo[]; /** Every tool with its own switch, in the order of its category. */ entries: ToolEntry[]; /** The categories, in the order to show them. */ categories: ToolCategory[]; backends: BackendInfo[]; /** How commands are confined on this computer (absent from a host that does not say). */ sandbox?: SandboxInfo }
  /** What has been typed and not sent, by conversation id (or `new`): the same in every window and on every device that reaches this computer. Not kept in the replayed history; ask with `drafts`. */
  /** Conversations that are still being worked on while another one is open: `working`, or `approval` when one waits for the person. Not kept in the replayed history; sent to every window when it changes and after `synced`. */
  | { ev: "background"; items: { id: string; kind?: SessionKind; state: "working" | "approval" }[] }
  | { ev: "drafts"; items: { key: string; text: string; updated: number }[] }
  /** The files conversations wrote here (of the kind the event carries). */
  | { ev: "artifacts"; items: ArtifactInfo[] }
  /** One file to show: `text` (cut at 1 MB, then `truncated`) or `data` (a picture, base64). */
  | { ev: "artifact"; id: string; name: string; mime: string; bytes: number; text?: string; data?: string; truncated?: true }
  /** How many conversations the account holds in the cloud that this computer does not have yet (said when the hub starts and after the list changes). */
  | { ev: "importable"; count: number }
  /** The result of a `move` or `copy`. */
  /** The result of a `fork`: the new conversation is `newId`. */
  | { ev: "forked"; id: string; newId?: string; ok: boolean; msg?: string }
  /** This computer saved (or already had) a conversation sent by another computer. */
  | { ev: "received"; id: string; ok: boolean; msg?: string }
  | { ev: "moved"; id: string; to: string; ok: boolean; copy?: boolean; msg?: string }
  | { ev: "synced"; /** The version of the program that runs the hub, so a page can show what it is connected to. */ version?: string; /** Which kinds of conversation have a reply being written right now, so a page that lost the end of one knows it is over. */ running?: string[] }
  /** A saved session is now the one in use. `items` is its conversation in short form, so every window can show it; the next prompt continues it and saves into it. */
  | { ev: "loaded"; id: string; items?: HistoryItem[] }
  /** The saved sessions, newest first. */
  | { ev: "sessions"; items: SessionInfo[] }
  /** The answer to `search`: the conversations that mention the words, best first, each with the passage (the words in [brackets]). */
  | { ev: "found"; query: string; items: SearchHit[] }
  | { ev: "caps"; kind?: SessionKind; questions?: true; manage?: true; rowActions?: true; schedule?: true; plugins?: true; skillReview?: true; memory?: true; memoryNotes?: true; media?: true; a2a?: true; mcpBrowse?: true; pluginInstall?: true; toolList?: true; drafts?: true; artifacts?: true; scheduleNote?: string; folders?: Capabilities["folders"]; steer: boolean; modes: PermMode[]; defaultMode?: PermMode; compact: boolean; checkpoints?: boolean; models?: ModelInfo[]; efforts?: Effort[]; effort?: Effort; vision?: boolean }
  | { ev: "checkpoints"; items: CheckpointInfo[] }
  /** The outcome of `restore`. A restore saves the current state first as `undoId`, so it can be undone. */
  | { ev: "restore"; id: string; preview: boolean; changes: RestoreEntry[]; undoId?: string }
  /** The text of a prompt the engine accepted, sent once just before its `taken`, so any window can show it. `images` is only a count. */
  | { ev: "user"; qid: string; text: string; images?: number; files?: FileNote[] }
  /** The engine started working on prompt `qid` (or took it in mid-turn). */
  | { ev: "taken"; qid: string }
  | { ev: "text"; text: string }
  | { ev: "thought"; text: string }
  /** The model stopped thinking; `ms` is how long it took. Sent once per stretch of thought. */
  | { ev: "thought_end"; ms: number }
  /**
   * A step of the work. Besides the status: `queued` (asked for in the same step as another, waits its turn), `live` (what a running command printed since the last event),
   * and, when it ends, `startedAt` (when the engine began it, milliseconds since the epoch, by the engine's own clock) and `ms` (how long), `code` (the exit code of a command), `truncated` (the output was cut), `cached` (the answer came from what was read lately, not from a new visit), and `outcome` when it is not a plain failure: `denied`
   * (the person said no), `blocked` (a rule or hook said no), `timeout`, `stopped` (cancelled), `skipped` (never started because the turn was stopped), `background` (it keeps running as a job), `redirected` (never started: the person sent a new message first, and it takes the place of the rest of the step).
   */
  | { ev: "tool"; id: string; name: string; status: ToolStatus; input?: unknown; output?: string; progress?: number; parent?: string; queued?: true; live?: string; ms?: number; startedAt?: number; code?: number | null; truncated?: true; cached?: true; screen?: ScreenOutcome; /** A picture the step saved (a screenshot of the Browser tool, the result of MakeImage); the step's `output` is the same short text as without it. */ picture?: PictureInfo; /** The picture, sound or video the step made, to fetch with `media.read`. */ media?: MediaRef; outcome?: ToolOutcome }
  /** The task list. `qid` is the prompt that started the turn it belongs to, `tool` the step (the `tool` event) that wrote it, so a page can show it inside that group. */
  | { ev: "plan"; entries: PlanEntry[]; raw?: string; qid?: string; tool?: string }
  /** Context window use: `ctx` tokens of `win`; `out` = tokens produced by the last model call. */
  | { ev: "usage"; ctx: number; win: number; out: number; turn?: TurnTokens }
  /** `tool` is the id of the step (the `tool` event) this question is about, so a page can put the buttons on that step. */
  | { ev: "approval"; id: string; title: string; options: ApprovalOption[]; change?: ApprovalChange; tool?: string; /** Why this is asked even in a mode that mostly does not ask (it cannot be undone), in plain words. */ risk?: string; /** Present when the question is a consent to use one application on the screen. */ screen?: ScreenAsk }
  /** The agent asks the person one to four questions and waits (only when `caps.questions` is set). Answered with the `answer` command; `tool` is the step that asked. */
  | { ev: "question"; id: string; questions: QuestionItem[]; tool?: string }
  /** Plan mode finished: the plan was streamed as `text`; the user may approve it. */
  | { ev: "plan_proposal"; id: string }
  | { ev: "phase"; name: "" | "starting" | "compacting" }
  /** A command running in the background: started, and again when it ends. `startedAt` is in ms since the epoch; `last` is the last line it printed, sent when it ends. */
  | { ev: "job"; id: string; title: string; status: "running" | "done" | "failed" | "stopped"; code?: number; startedAt?: number; last?: string }
  | { ev: "alive" }
  /** Sent by a hosting server, not by an engine, while a session waits for a free place: 1 is next. */
  | { ev: "queue"; position: number }
  | { ev: "done"; stop: StopReason }
  /** Something worth telling the person that does not stop the work, such as a connected program that could not start. */
  /** A call to the model failed in a way that is worth trying again (it was busy, asked to slow down, broke, or the connection dropped) and will be tried again after `inSeconds`: `attempt` is the try that comes next, out of `of`. Said before each wait; the turn goes on by itself, so a page may show it as a quiet line or ignore it. */
  | { ev: "retry"; reason: string; attempt: number; of: number; inSeconds: number }
  | { ev: "notice"; msg: string }
  | { ev: "error"; msg: string };

export type EventName = EngineEvent["ev"];

/** Every event on the wire carries a monotonically increasing sequence number and a unique id (replay, de-duplication). */
export type Stamped<E extends EngineEvent = EngineEvent> = E & { seq: number; eid: string };

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };
