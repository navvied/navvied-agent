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
export interface ScheduleAddCommand { cmd: "schedule.add"; title?: string; cron: string; prompt: string; folder?: string; mode?: "plan" | "auto" }
export interface ScheduleUpdateCommand { cmd: "schedule.update"; id: string; title?: string; cron?: string; prompt?: string; enabled?: boolean; mode?: "plan" | "auto"; folder?: string }
export interface ScheduleRemoveCommand { cmd: "schedule.remove"; id: string }
/** Run a scheduled task now. */
export interface ScheduleRunCommand { cmd: "schedule.run"; id: string }
/** Ask for what extends the agent on this computer: skills, outside tool servers and hooks (answered with `plugins`). Adding or removing one is done on the computer, never from a page. */
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
/** Choose where the Bash tool runs its commands, for the conversations that start afterwards. */
export interface TerminalUseCommand { cmd: "terminal.use"; backend: "local" | "docker" | "ssh" }
export interface PluginToggleCommand { cmd: "plugin.toggle"; id: string; enabled: boolean }
/** Ask for the files conversations wrote (of one conversation, with `id`; answered with `artifacts`). */
export interface ArtifactsCommand { cmd: "artifacts"; id?: string }
/** Read one file to show it: text or a picture. A file is named by the `id` the hub gave; a path is never taken. Answered with `artifact`. */
export interface ArtifactReadCommand { cmd: "artifact.read"; id: string }
/** Give a saved conversation another title. Answered with the updated `sessions` event. */
export interface RenameCommand { cmd: "rename"; id: string; title: string }
/** Delete a saved conversation (here and on the account). Deleting the one in use starts a new one. */
export interface RemoveCommand { cmd: "remove"; id: string }
/** Keep a conversation at the top of the list, or let it go back to its place. */
export interface PinCommand { cmd: "pin"; id: string; pinned: boolean }
export interface RestoreCommand { cmd: "restore"; id: string; preview?: boolean }

/** Every command may say which kind of conversation it is for. */
export type Command = (PromptCommand | CancelCommand | ApproveCommand | CompactCommand | ModelCommand | EffortCommand | LoadCommand | SessionsCommand | SearchCommand | CheckpointsCommand | RestoreCommand | JobStopCommand | NewCommand | RenameCommand | RemoveCommand | PinCommand | ImportCommand | TransferCommand | ForkCommand | ArchiveCommand | MarkCommand | ReceiveCommand | SchedulesCommand | ScheduleAddCommand | ScheduleUpdateCommand | ScheduleRemoveCommand | ScheduleRunCommand | PluginsCommand | PluginToggleCommand | DraftCommand | DraftsCommand | ToolsCommand | ToolToggleCommand | TerminalUseCommand | ArtifactsCommand | ArtifactReadCommand) & { kind?: SessionKind };
export type CommandName = Command["cmd"];

/* ── engine → front-end ─────────────────────────────────────────────────────────────────────────────────────── */

/** A saved session as a list shows it. `updated` is in ms since the epoch. */
export interface SessionInfo { /** Absent: `agent`. */ kind?: SessionKind; /** A reply is being written for it right now, on this computer (in front, or in the background). */ running?: true; /** A turn ended while no window was looking, and nobody has opened it since. */ unread?: true; /** Marked complete by the person. */ done?: true; /** Archived (only in the archived list). */ archived?: true; /** Where it is kept: on this computer, or in the cloud (the account). Absent: this computer. */ where?: "this" | "cloud"; /** Kept at the top of the list. */ pinned?: true; id: string; title: string; updated: number; messages: number; /** Where it took place when that is not this computer: the name of another computer, or "hosted". */ source?: string; /** The folder it was about (its name only), so a list can be grouped by project. */ project?: string }

/** A file a conversation wrote. `path` is for showing on the same machine only. */
export interface ArtifactInfo { id: string; conversation: string; name: string; bytes: number; updated: number; mime: string; path?: string }

/** Something that extends the agent. `fromNext`: a change reaches the next new conversation. */
/** One tool of the agent, in plain words. `access` says what it can do to the computer; `core` tools are what coding is made of; `small` says a small model is offered it without asking. */
export interface ToolInfo { name: string; title: string; about: string; access: "read" | "change" | "run" | "web"; enabled: boolean; core: boolean; small: boolean; /** How many times the agent used it on this computer. */ calls: number; /** The id of the set it belongs to. */ set: string }
/** Tools that belong together, shown as one card: what they are for, how many there are, and how often they were used. */
export interface ToolSetInfo { id: string; title: string; about: string; tools: string[]; enabled: boolean; calls: number }
/** One place the Bash tool can run commands: `ready` says it can be used now, `hint` says what to do when it cannot. */
export interface BackendInfo { id: "local" | "docker" | "ssh"; label: string; about: string; ready: boolean; using: boolean; hint?: string }
export interface PluginInfo { id: string; kind: "skill" | "mcp" | "hook"; name: string; description: string; enabled: boolean; source: "user" | "project" | "config"; fromNext?: true }

/** A scheduled task as a list shows it. Times are ms since the epoch. */
export interface ScheduleInfo { id: string; title: string; prompt: string; cron: string; /** When it runs next (none while turned off). */ next?: number; last?: number; /** How the last run ended: 0 is fine. */ lastCode?: number | null; enabled: boolean; folder?: { id: string; name: string }; kind: SessionKind; mode: "plan" | "auto"; running?: true }

/** A conversation that mentions what was searched for. */
/** A conversation that mentions what was searched for. `where` and `project` are as in the list; a title found in the cloud has an empty `snippet`. */
export interface SearchHit { id: string; title: string; snippet: string; updated: number; where?: "cloud"; project?: string }

/** One step of a loaded conversation: what the person said, what the model answered, or the name of a tool it used. */
export interface HistoryItem { k: "user" | "assistant" | "tool"; text: string }

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
  /** Whether this model takes file attachments from whoever is asking. Left out means yes. */
  files?: boolean;
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

/** What a turn has used so far (or in all): tokens sent to the model (`in`, every call counted), tokens it wrote (`out`), and how many times the model was called. */
export interface TurnTokens { in: number; out: number; calls: number }
/** What an action would change, so a page can show it next to the question. Long text is cut and `truncated` is set. */
export type ApprovalChange =
  | { tool: "Edit"; file: string; old: string; new: string; truncated?: true }
  | { tool: "Write"; file: string; content: string; truncated?: true }
  | { tool: "Bash"; command: string; truncated?: true };
export interface PlanEntry { title: string; status: "pending" | "in_progress" | "completed" | (string & {}) }

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
  /** The things that extend the agent here (sent when asked and when one is switched). */
  | { ev: "plugins"; items: PluginInfo[] }
  /** A message was received and is waiting its turn (the agent is busy, or still starting): every window shows it as waiting, not only the one that sent it. It is followed by `user` and `taken` when the agent takes it. */
  | { ev: "queued"; qid: string; text: string; images?: number; files?: FileNote[] }
  /** Waiting messages that were thrown away without being taken (the person stopped the agent, or it failed): windows take them off the screen. */
  | { ev: "dropped"; qids: string[] }
  | { ev: "tools"; items: ToolInfo[]; sets: ToolSetInfo[]; backends: BackendInfo[] }
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
  | { ev: "caps"; kind?: SessionKind; manage?: true; rowActions?: true; schedule?: true; plugins?: true; toolList?: true; drafts?: true; artifacts?: true; scheduleNote?: string; folders?: Capabilities["folders"]; steer: boolean; modes: PermMode[]; defaultMode?: PermMode; compact: boolean; checkpoints?: boolean; models?: ModelInfo[]; efforts?: Effort[]; effort?: Effort; vision?: boolean }
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
   * and, when it ends, `ms` (how long), `code` (the exit code of a command), `truncated` (the output was cut), and `outcome` when it is not a plain failure: `denied`
   * (the person said no), `blocked` (a rule or hook said no), `timeout`, `stopped` (cancelled), `skipped` (never started because the turn was stopped), `background` (it keeps running as a job), `redirected` (never started: the person sent a new message first, and it takes the place of the rest of the step).
   */
  | { ev: "tool"; id: string; name: string; status: ToolStatus; input?: unknown; output?: string; progress?: number; parent?: string; queued?: true; live?: string; ms?: number; code?: number | null; truncated?: true; outcome?: ToolOutcome }
  /** The task list. `qid` is the prompt that started the turn it belongs to, `tool` the step (the `tool` event) that wrote it, so a page can show it inside that group. */
  | { ev: "plan"; entries: PlanEntry[]; raw?: string; qid?: string; tool?: string }
  /** Context window use: `ctx` tokens of `win`; `out` = tokens produced by the last model call. */
  | { ev: "usage"; ctx: number; win: number; out: number; turn?: TurnTokens }
  /** `tool` is the id of the step (the `tool` event) this question is about, so a page can put the buttons on that step. */
  | { ev: "approval"; id: string; title: string; options: ApprovalOption[]; change?: ApprovalChange; tool?: string; /** Why this is asked even in a mode that mostly does not ask (it cannot be undone), in plain words. */ risk?: string }
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
  | { ev: "notice"; msg: string }
  | { ev: "error"; msg: string };

export type EventName = EngineEvent["ev"];

/** Every event on the wire carries a monotonically increasing sequence number and a unique id (replay, de-duplication). */
export type Stamped<E extends EngineEvent = EngineEvent> = E & { seq: number; eid: string };

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };
