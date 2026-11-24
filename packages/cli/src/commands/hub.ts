/**
 * The one place an engine and the people looking at it meet. A page on this computer, a page reached through the relay
 * and a program on standard input all attach here: each gets what the engine says, and each can send it commands.
 * The session lives in this process, so a client that comes back with the last number it saw receives what it missed.
 */
import { EventEncoder, parseCommand, type Command, type EngineEvent, type HistoryItem, type ScheduleInfo, type SessionInfo, type SessionKind } from "@navvied/protocol";
import { historyOf } from "@navvied/engine";
import type { Options } from "../args.ts";
import { FileSessionStore, forgetCheckpoints, type Recall } from "@navvied/engine";
import { createEngine, modelInfoOf, resolved, type Created } from "../create.ts";
import { checkTarget, handedOver, otherKind, transcriptOf } from "../handover.ts";
import { FolderBook, folderId } from "../folders.ts";
import { ScheduleStore, dueJobs, type Job } from "../schedules.ts";
import { runJob } from "../schedule-run.ts";
import { PluginState, listPlugins } from "../plugins.ts";
import { ArtifactBook, scanFolder } from "../artifacts.ts";
import { nextRun, parseCron } from "../cron.ts";
import { ToolUsage, listSets, listTools, toolId } from "../tools-info.ts";
import { TerminalState, listBackends } from "../terminal.ts";
import { DraftStore } from "../drafts.ts";
import { checkCredentialFile, findCredentialFile } from "../adc.ts";
import { localModels } from "../local-models.ts";
import { readMachine, realProbe, type Probe } from "../machine.ts";
import { askModels, detectApi, newEndpointId, reportEndpoints, type EndpointRecord } from "../endpoints.ts";
import { API_STYLES, MODEL_HUB, PROVIDERS, authHeaders } from "../presets.ts";
import { ONLY_ON_A_COMPUTER, baseOf, entryName, headersOf, listModels, mergeSaved, modelEntryOf, reportOf, type ListedRoute } from "../providers.ts";
import { accountPath, chatFilesDir, chatJournalDir, chatSearchIndexPath, chatSessionsDir, configPath, foldersPath, localDir, journalDir, loadConfig, saveEndpoint, saveModel, saveProvider, pluginStatePath, terminalStatePath, toolUsagePath, draftsPath, checkpointsDir, scheduledDir, schedulesPath, searchIndexPath, sessionsDir } from "../config.ts";
import { SearchIndex } from "../search-index.ts";
import { readAccount, type Account } from "../account.ts";
import { deleteConversation, getConversation, listComputers, listConversations, type AccountComputer } from "../account-client.ts";
import { talkToComputer } from "../relay-client.ts";
import { relayUrlFor } from "../computer.ts";
import { SessionMetaFile } from "../session-meta.ts";
import { computerName } from "../computer.ts";
import { Journal, messagesOf, titleOf } from "../journal.ts";
import type { IO } from "../io.ts";
import { VERSION } from "../help.ts";
import { basename, dirname, join, resolve } from "node:path";
import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";

const HISTORY = 5000;
/** While no model is connected the configuration is looked at this often, so a page connects itself once one is set up. */
const WATCH_MS = 1000;

export interface Client { send(text: string): unknown }

export interface HubOptions {
  /** Run the scheduled tasks while this hub is up (a server wants this; the interactive app runs them itself). Default false. */
  schedule?: boolean;
  /** How a scheduled task is run (a test gives its own). */
  runner?: typeof runJob;
  /** The computers of the account (a test gives its own). */
  computers?: () => Promise<AccountComputer[]>;
  /** The relay to reach other computers by (a test gives its own). */
  relayUrl?: string;
  /** How long a transfer to another computer may take, in milliseconds. */
  transferMs?: number;
  /** Bring the hosted conversations of the signed-in account onto this computer when it starts (default true). */
  import?: boolean;
  /** The computer models are planned for, when it is not the one this runs on (a test gives its own). */
  probe?: () => Probe;
  /** Look for a model again every second while there is none (a server wants this; the interactive app sets one up itself). Default true. */
  watch?: boolean;
}

export interface Hub {
  /** Replays what the client missed since `since`, then keeps it up to date. Returns the way to detach. */
  attach(client: Client, since: number): () => void;
  /** One protocol command as text. Anything the sender must be told straight away goes to `reply`. */
  command(text: string, reply: (text: string) => void): void;
  /** Whether a model is connected right now (it is looked for again each time this is asked). */
  connected(): boolean;
  info(): { model: string | null; cwd: string; session: string | null };
  /** The running engine and what is known about it, or nothing while no model is connected. */
  created(): Created | undefined;
  /** Why there is no engine. */
  error(): string;
  /** Stop what every open conversation is doing. */
  cancel(): void;
  /** Start a new engine from the current configuration. Clients and history stay; the old engine is closed. */
  restart(): { ok: true } | { ok: false; error: string };
  stop(): Promise<void>;
}

/**
 * One kind of conversation on this computer, with everything of its own: its engine, the record of what was said, its saved
 * conversations and the search over them. An agent and a chat never share any of it.
 */
/**
 * A conversation's engine and what goes with it. The one a person has open is the lane's; when they open another while it is being
 * answered, it is put aside (`bg`) and goes on: what it says is sent marked with its id, and when it is done it is marked unread.
 */
interface Slot {
  lane: Lane;
  bg: boolean;
  id: string | undefined;
  created: Created | undefined;
  journal: Journal;
  running: boolean;
  /** A step waits for the person to allow it. */
  asking: boolean;
  /** What was said since the last message was taken, so a window that opens it again is shown the turn so far. */
  turn: EngineEvent[];
  writing: Map<string, string>;
}
/** How many conversations may be answered in the background at once, per computer. */
const MOST_BACKGROUND = 4;

interface Lane {
  kind: SessionKind;
  slot?: Slot;
  /** What was said since the last message was taken (the open conversation's). */
  turn: EngineEvent[];
  /** What its engine is made from. */
  options: Options;
  journal: Journal;
  storeDir: string;
  meta: SessionMetaFile;
  /** The files its conversations wrote. */
  artifacts: ArtifactBook;
  /** Files named by tool steps still running, and (for a chat) what its folder held when the turn began. */
  writing: Map<string, string>;
  folderBefore?: Map<string, string>;
  indexPath: string;
  index?: SearchIndex;
  created?: Created;
  error: string;
  running: boolean;
  /** The ids the engine itself can switch to, as it last said (what is left of the list is reached by handing the conversation over). */
  engineModels?: Set<string>;
  /** What the engine itself last said of its abilities, before the hub added to it: said again, merged with the configuration as it is now, when the models change. */
  engineCaps?: Extract<EngineEvent, { ev: "caps" }>;
  /** A model of the other kind asked for while a reply was being written: the hand-over waits for its end. */
  switchTo?: string;
  /** What a conversation held before it went to a program, to be written down under the id the program gives it. */
  carry?: HistoryItem[];
}

export function createHub(options: Options, io: IO, hubOptions: HubOptions = {}): Hub {
  const encoder = new EventEncoder();
  /** What was said, in order. `starts` marks the first event of a conversation (a new one, or one opened), so a window that arrives fresh can be given only the current one of each kind. */
  const history: { seq: number; line: string; kind: SessionKind; starts: boolean; caps: boolean }[] = [];
  const clients = new Set<Client>();
  /** What a command that says nothing about it is for: the kind this program was started for. */
  const primary: SessionKind = options.kind ?? "agent";
  /** The account this computer is signed in to, if any. */
  const signedIn = (): Account | undefined => readAccount(accountPath(io.env, options.config));
  /** What the account holds, as last asked, of every kind. Asked again each time a window asks for the list. */
  let remote: SessionInfo[] = [];
  const refreshRemote = async (): Promise<boolean> => {
    const account = signedIn();
    if (!account) { const had = remote.length > 0; remote = []; return had; }
    try {
      const me = computerName();
      const next = (await listConversations(io.fetch, account)).map((c): SessionInfo => ({ id: c.id, title: c.title, updated: c.updated, messages: c.messages, ...(c.kind === "chat" ? { kind: "chat" as const } : {}), ...(c.source && c.source !== me ? { source: c.source } : {}), ...(c.project ? { project: c.project } : {}) }));
      const changed = JSON.stringify(next) !== JSON.stringify(remote);
      remote = next;
      return changed;
    } catch { return false; }
  };

  /** The folders an agent may be started in: the one it started in, the ones worked in lately, the ones the person named in their configuration. */
  const folderBook = new FolderBook(foldersPath(io.env));
  const namedFolders = (): string[] => { const f = loadConfig(configPath(io.env, options.config), io.env); return f.ok ? (f.value?.folders ?? []) : []; };

  /** The model of this computer's own server while it runs (set once the server is made: the first lane is made before it). */
  let runningLocal = (): string | undefined => undefined;
  const lanes = new Map<SessionKind, Lane>();
  const projectName = (): string | undefined => { try { return basename(lanes.get("agent")?.created?.cwd ?? resolve(options.cwd ?? process.cwd())) || undefined; } catch { return undefined; } };
  const newJournal = (lane: Lane): Journal => new Journal(lane.kind === "chat" ? chatJournalDir(io.env) : journalDir(io.env), (id, items) => {
    try { searchIndexOf(lane)?.put(id, titleOf(items), Date.now(), items); } catch { /* searching is a convenience: it never stops a conversation */ }
  }, lane.kind === "agent" ? projectName : () => undefined);
  const laneFor = (kind: SessionKind): Lane => {
    const had = lanes.get(kind);
    if (had) return had;
    // The primary lane is made from the options as they are (they may change: a conversation is opened by setting `session`); another one starts clean.
    const own: Options = kind === primary ? options : (() => { const { session: _session, cwd: _cwd, ...rest } = options; return { ...rest, kind, ...(kind === "agent" && options.cwd ? { cwd: options.cwd } : {}) }; })();
    const lane: Lane = {
      kind, options: own, error: "", running: false, turn: [],
      storeDir: kind === "chat" ? chatSessionsDir(io.env) : sessionsDir(io.env),
      indexPath: kind === "chat" ? chatSearchIndexPath(io.env) : searchIndexPath(io.env),
      artifacts: new ArtifactBook(join(dirname(kind === "chat" ? chatSessionsDir(io.env) : sessionsDir(io.env)), "artifacts.json")),
      writing: new Map(),
      meta: new SessionMetaFile(join(dirname(kind === "chat" ? chatSessionsDir(io.env) : sessionsDir(io.env)), "sessions-meta.json")),
      journal: undefined as never,
    };
    lane.journal = newJournal(lane);
    lanes.set(kind, lane);
    return lane;
  };
  /** The search index is opened when first needed; a computer that never searches never makes one until a conversation is saved. */
  const searchIndexOf = (lane: Lane): SearchIndex | undefined => { try { return (lane.index ??= new SearchIndex(lane.indexPath)); } catch { return undefined; } };
  /** The first time, everything already kept is put into the index. */
  const fillIndex = (lane: Lane, db: SearchIndex): void => {
    if (!db.empty) return;
    const store = new FileSessionStore(lane.storeDir);
    for (const s of lane.journal.list(500)) { const items = lane.journal.items(s.id); if (items) db.put(s.id, s.title, s.updated, items); }
    for (const s of store.list(500)) { if (lane.journal.items(s.id)) continue; const m = store.load(s.id); if (m) db.put(s.id, s.title, s.updated, historyOf(m, 400)); }
  };
  /** The agent's own way to look through earlier conversations (the Recall tool): the same index and records as the `search` command. */
  const recallFor = (lane: Lane): Recall => ({
    search: (query, limit) => { const db = searchIndexOf(lane); if (!db) return []; fillIndex(lane, db); return db.search(query, limit); },
    read: (id) => lane.journal.items(id)?.slice(-60),
  });

  /** Which files a conversation wrote: the ones its Write and Edit steps named, and, for a chat, the ones that are new or changed in its folder after a turn. */
  const noteFiles = (lane: Lane, e: EngineEvent): void => {
    try {
      const where = lane.created?.cwd ?? resolve(lane.options.cwd ?? (lane.kind === "chat" ? chatFilesDir(io.env) : process.cwd()));
      const conversation = lane.created?.engine.sessionId;
      if (e.ev === "tool" && (e.name === "Write" || e.name === "Edit")) {
        const file = (e.input as { file_path?: unknown } | undefined)?.file_path;
        if (e.status === "running" && typeof file === "string") lane.writing.set(e.id, resolve(where, file));
        else if (e.status === "done" && conversation && lane.writing.has(e.id)) { lane.artifacts.add(conversation, lane.writing.get(e.id)!); lane.writing.delete(e.id); }
        else if (e.status === "error") lane.writing.delete(e.id);
      }
      if (lane.kind === "chat") {
        if (e.ev === "taken") lane.folderBefore = scanFolder(where);
        if (e.ev === "done" && lane.folderBefore && conversation) {
          const after = scanFolder(where);
          for (const [path, stamp] of after) if (lane.folderBefore.get(path) !== stamp) lane.artifacts.add(conversation, path);
          lane.folderBefore = undefined;
        }
      }
    } catch { /* a list of files is a convenience: it never stops a conversation */ }
  };

  /** The models that only a hand-over reaches, from the configuration as it is now. */
  const otherKinds = (lane: Lane): ReturnType<typeof otherKind> => {
    const path = configPath(io.env, lane.options.config);
    const file = loadConfig(path, io.env);
    if (!file.ok) return [];
    const now = resolved(lane.options.model, file.value, io.env, path);
    const programNow = now.ok && !!now.value.cli;
    // A model of the engine's own kind that was added since it started (a provider's, an endpoint's) is reached by a hand-over too.
    const added = programNow ? [] : Object.entries(file.value?.models ?? {}).filter(([id, e]) => !e.command && !lane.engineModels?.has(id) && (!e.local || id === runningLocal())).map(([id, e]) => ({ ...modelInfoOf(id, e), handover: true as const }));
    return [...added, ...otherKind(file.value, programNow, lane.kind === "chat")];
  };
  /** The models the engine lists that the configuration no longer has (a provider or an endpoint was removed since it started). */
  const removedModels = (lane: Lane): Set<string> => {
    const file = loadConfig(configPath(io.env, lane.options.config), io.env);
    if (!file.ok || !file.value) return new Set();
    const have = file.value.models;
    return new Set([...(lane.engineModels ?? [])].filter((id) => !(id in have) || (have[id]!.local !== undefined && id !== runningLocal())));
  };
  /** Every window is told at once which models there are now: a saved endpoint's models are in the list, a removed one's are gone, with no restart. */
  const pushModels = (): void => { for (const lane of lanes.values()) if (lane.engineCaps) say(lane, lane.engineCaps); };
  /** What a lane says, to every window: stamped with the kind when it is not an agent, and kept for a window that comes later. */
  const say = (lane: Lane, e: EngineEvent): void => {
    // A conversation that came to a program from another model goes on under the id the program gives it, with what was said before.
    if (e.ev === "session" && lane.carry) { lane.journal.write(e.id, lane.carry); lane.carry = undefined; }
    lane.journal.record(e);
    if (e.ev === "taken") { lane.running = true; lane.turn = []; } else if (e.ev === "done") lane.running = false;
    if (lane.running) { lane.turn.push(e); if (lane.turn.length > 3000) lane.turn.splice(0, lane.turn.length - 3000); }
    if (lane.slot) { if (e.ev === "approval") lane.slot.asking = true; else if (e.ev === "tool" || e.ev === "done") lane.slot.asking = false; }
    if (e.ev === "tool" && e.status === "running") toolUsage.add(e.name);
    // Whatever the engine, this hub can manage the list of conversations of its kind: say so with the abilities.
    const folders = e.ev === "caps" && lane.kind === "agent" ? folderBook.offered(resolve(lane.options.cwd ?? process.cwd()), namedFolders()).map((f) => ({ id: f.id, name: f.name, path: f.path, ...(f.last ? { last: f.last } : {}), ...(f.current ? { current: true as const } : {}) })) : undefined;
    // Every model there is is offered in one list: the engine's own, and the ones only a hand-over reaches.
    if (e.ev === "caps") { lane.engineModels = new Set((e.models ?? []).map((m) => m.id)); lane.engineCaps = e; }
    const more = e.ev === "caps" ? otherKinds(lane) : [];
    const gone = e.ev === "caps" ? removedModels(lane) : new Set<string>();
    const said: EngineEvent = e.ev === "caps" ? { ...e, ...(more.length || gone.size ? { models: [...(e.models ?? []).filter((m) => m.current || !gone.has(m.id)), ...more] } : {}), manage: true, rowActions: true, schedule: true, plugins: true, toolList: true, drafts: true, artifacts: true, scheduleNote: "Tasks run only while this computer is on and navvied is running.", ...(folders ? { folders } : {}) } : e;
    noteFiles(lane, e);
    // Each answer moves its conversation up the list: told just before the end of the turn, so that the end is still the last word of it.
    if (e.ev === "done" && lane.created) say(lane, { ev: "sessions", items: listSessions(lane) });
    // A model of the other kind that was asked for during the reply is taken up once the reply is over (and nothing else is queued behind it).
    if (e.ev === "done" && lane.switchTo) { const id = lane.switchTo; lane.switchTo = undefined; queueMicrotask(() => { if (lane.running) lane.switchTo = id; else switchModel(lane, id); }); }
    // A turn that ended while nobody was looking is marked unread, until someone opens it.
    if (e.ev === "done" && clients.size === 0) { const id = lane.created?.engine.sessionId; if (id) lane.meta.update((m) => { if (!m.unread.includes(id)) m.unread.push(id); }); }
    const stamped = encoder.stamp(lane.kind === "agent" ? said : { ...said, kind: lane.kind });
    const line = JSON.stringify(stamped);
    history.push({ seq: stamped.seq, line, kind: lane.kind, starts: e.ev === "session" || e.ev === "loaded", caps: e.ev === "caps" });
    if (history.length > HISTORY) history.splice(0, history.length - HISTORY);
    for (const c of clients) c.send(line);
    // The list of conversations is up to date in every window as it goes: a new conversation is in it as soon as its first message is taken.
    if (e.ev === "taken" && lane.created) say(lane, { ev: "sessions", items: listSessions(lane) });
  };

  /** What is said by an engine that was put aside: marked with its conversation and not kept for a window that arrives later. */
  const sayAside = (slot: Slot, e: EngineEvent): void => {
    const lane = slot.lane;
    slot.journal.record(e);
    if (e.ev === "session" || e.ev === "loaded") slot.id = e.id;
    if (e.ev === "taken") { slot.running = true; slot.turn = []; }
    if (slot.running) { slot.turn.push(e); if (slot.turn.length > 3000) slot.turn.splice(0, slot.turn.length - 3000); }
    if (e.ev === "approval") slot.asking = true; else if (e.ev === "tool" || e.ev === "done") slot.asking = false;
    if (e.ev === "tool" && e.status === "running") toolUsage.add(e.name);
    noteFiles({ ...lane, created: slot.created, writing: slot.writing } as Lane, e);
    const line = JSON.stringify({ ...encoder.stamp(lane.kind === "agent" ? e : { ...e, kind: lane.kind }), bg: slot.id ?? "" });
    for (const c of clients) c.send(line);
    if (e.ev === "done") finishAside(slot); else if (e.ev === "approval") tellBackground();
  };
  const asideSlots = new Set<Slot>();
  /** Which conversations are still being worked on while another is open, told to every window (and to one that arrives, after `synced`). */
  const backgroundLine = (): string => JSON.stringify(encoder.stamp({ ev: "background", items: [...asideSlots].filter((s) => s.id).map((s) => ({ id: s.id!, ...(s.lane.kind === "chat" ? { kind: "chat" as const } : {}), state: s.asking ? "approval" as const : "working" as const })) }));
  const tellBackground = (): void => { const line = backgroundLine(); for (const c of clients) c.send(line); };
  /** A conversation answered in the background is done: it is marked unread (nobody was looking), and its engine is let go; the conversation itself is kept. */
  const finishAside = (slot: Slot): void => {
    slot.running = false;
    const lane = slot.lane;
    if (slot.id) { const id = slot.id; lane.meta.update((m) => { if (!m.unread.includes(id)) m.unread.push(id); }); }
    asideSlots.delete(slot);
    const engine = slot.created?.engine;
    slot.created = undefined;
    if (engine) setTimeout(() => { void engine.idle().then(() => engine.close()); }, 0);
    tellBackground();
    say(lane, { ev: "sessions", items: listSessions(lane) });
  };
  /** The conversation that is being answered goes on in the background, so another can be opened. False (and a word to the person) when too many already do. */
  const putAside = (lane: Lane): boolean => {
    if (!lane.running || !lane.created || !lane.slot) return true;
    if (asideSlots.size >= MOST_BACKGROUND) { say(lane, { ev: "error", msg: "Too many conversations are running. Wait for one to finish." }); return false; }
    const slot = lane.slot;
    slot.bg = true;
    slot.id = lane.created.engine.sessionId ?? slot.id;
    slot.created = lane.created;
    slot.journal = lane.journal;
    slot.running = true;
    slot.turn = lane.turn;
    slot.writing = lane.writing;
    asideSlots.add(slot);
    lane.created = undefined; lane.slot = undefined; lane.running = false; lane.turn = []; lane.writing = new Map(); lane.folderBefore = undefined;
    lane.journal = newJournal(lane);
    tellBackground();
    say(lane, { ev: "sessions", items: listSessions(lane) });
    return true;
  };
  /** Opens again a conversation that was put aside: every window is shown it, and the turn so far, as if it had been open all along. */
  const bringBack = (lane: Lane, slot: Slot): boolean => {
    if (lane.running && !putAside(lane)) return false;
    lane.created?.engine.close();
    asideSlots.delete(slot);
    slot.bg = false;
    lane.created = slot.created; lane.slot = slot; lane.journal = slot.journal; lane.running = slot.running; lane.turn = slot.turn; lane.writing = slot.writing;
    const show = (e: EngineEvent, starts: boolean): void => {
      const stamped = encoder.stamp(lane.kind === "agent" ? e : { ...e, kind: lane.kind });
      const line = JSON.stringify(stamped);
      history.push({ seq: stamped.seq, line, kind: lane.kind, starts, caps: false });
      if (history.length > HISTORY) history.splice(0, history.length - HISTORY);
      for (const c of clients) c.send(line);
    };
    show({ ev: "loaded", id: slot.id!, items: lane.journal.items(slot.id!) ?? [] }, true);
    for (const e of lane.turn) show(e, false);
    tellBackground();
    say(lane, { ev: "sessions", items: listSessions(lane) });
    return true;
  };
  /** An engine for a lane, with its own slot: what it says goes through `say` while it is the open one, and through `sayAside` once it is put aside. */
  const engineFor = (lane: Lane, earlier?: string): ReturnType<typeof createEngine> => {
    const slot: Slot = { lane, bg: false, id: undefined, created: undefined, journal: lane.journal, running: false, asking: false, turn: [], writing: lane.writing };
    lane.slot = slot;
    return createEngine(lane.options, io, (e) => { if (slot.bg) sayAside(slot, e); else say(lane, e); }, { recall: recallFor(lane), ...(earlier ? { earlier } : {}) });
  };

  const connect = (lane: Lane): Created | undefined => {
    if (lane.created) return lane.created;
    const made = engineFor(lane);
    if (made.ok) { lane.created = made.value; if (lane.kind === "agent") folderBook.used(made.value.cwd); } else lane.error = made.error;
    return lane.created;
  };
  const main = laneFor(primary);
  connect(main);
  // A computer that is signed in says how many conversations wait for it in the cloud; it takes none of them until the person asks.
  queueMicrotask(() => { void refreshRemote().then((changed) => { if (changed) relistAll(); announceImportable(); }); });
  const watching = main.created || hubOptions.watch === false ? undefined : setInterval(() => { if (connect(main)) clearInterval(watching); }, WATCH_MS);
  watching?.unref?.();

  /** Every conversation of one kind that can be opened: the ones its engine kept itself and the ones this computer watched, newest first, without repeats. */
  const listSessions = (lane: Lane, archived = false): SessionInfo[] => {
    const all = new Map<string, SessionInfo>();
    const mine = remote.filter((s) => (s.kind ?? "agent") === lane.kind);
    const tag = (s: SessionInfo): SessionInfo => (lane.kind === "chat" ? { ...s, kind: "chat" } : s);
    const here = [...new FileSessionStore(lane.storeDir).list().map(tag), ...lane.journal.list().map(tag)];
    const local = new Set(here.map((s) => s.id));
    // What the account holds and this computer does not have is "in the cloud"; what is here is here, whatever else holds a copy.
    for (const s of [...mine.map((s): SessionInfo => (local.has(s.id) ? s : { ...s, where: "cloud" })), ...here]) { const had = all.get(s.id); const winner = !had || s.updated > had.updated ? s : had; const project = winner.project ?? (had === winner ? s.project : had?.project); all.set(s.id, { ...winner, ...(project ? { project } : {}) }); }
    // What the person did to the list: titles they gave, what they pinned, what they deleted (a copy on the account may still be there).
    const meta = lane.meta.read();
    const gone = new Set(meta.removed), pinned = new Set(meta.pinned), hidden = new Set(meta.archived), unread = new Set(meta.unread), finished = new Set(meta.done);
    const shown = [...all.values()].filter((s) => !gone.has(s.id) && hidden.has(s.id) === archived).map((s): SessionInfo => ({ ...s, ...(meta.titles[s.id] ? { title: meta.titles[s.id]! } : {}), ...(pinned.has(s.id) ? { pinned: true as const } : {}), ...(unread.has(s.id) ? { unread: true as const } : {}), ...(finished.has(s.id) ? { done: true as const } : {}), ...(archived ? { archived: true as const } : {}) }));
    const working = new Set<string>([...asideSlots].filter((x) => x.lane === lane && x.id).map((x) => x.id!));
    if (lane.running && lane.created?.engine.sessionId) working.add(lane.created.engine.sessionId);
    return shown.map((s) => (working.has(s.id) ? { ...s, running: true as const } : s)).sort((a, b) => Number(b.pinned === true) - Number(a.pinned === true) || b.updated - a.updated).slice(0, 50);
  };
  /** A conversation that was only watched (it took place through a program, or before this engine kept sessions) can still be continued by an engine that keeps its own: what was said is handed to it as its own history. */
  const adoptWatched = async (lane: Lane, id: string): Promise<void> => {
    const store = new FileSessionStore(lane.storeDir);
    if (store.load(id)) return;
    let items = lane.journal.items(id);
    // A conversation of another computer, or of a hosted session, is fetched from the account.
    if (!items?.length) { const account = signedIn(); if (account) items = (await getConversation(io.fetch, account, id).catch(() => undefined))?.items; }
    if (items?.length) { try { store.save(id, messagesOf(items)); } catch { /* the engine will say it was not found */ } }
  };
  /**
   * A model that the engine of this conversation cannot run itself (a program, from an engine of navvied's; or navvied's own, from a
   * program): the conversation goes on with it, with what was said so far. It is asked of the configuration and refused before anything
   * is closed; a reply being written finishes first.
   */
  const switchModel = (lane: Lane, id: string): void => {
    const path = configPath(io.env, lane.options.config);
    const file = loadConfig(path, io.env);
    const target = checkTarget(file.ok ? file.value : null, io.env, path, id, lane.kind === "chat");
    if (!target.ok) { say(lane, { ev: "error", msg: target.error }); return; }
    if (lane.running) { lane.switchTo = id; return; }
    void handOver(lane, id, target.program, file.ok ? file.value?.models[id]?.display?.name ?? id : id);
  };
  const handOver = async (lane: Lane, id: string, toProgram: boolean, name: string): Promise<void> => {
    const before = { model: lane.options.model, session: lane.options.session };
    // A conversation that has no message yet has an id but nothing saved: there is nothing to carry, and loading it would be told it was not found.
    // (A program keeps its own sessions: what is said so far is the journal's.)
    const named = lane.created?.engine.sessionId;
    const kept = named && (lane.created?.program ? lane.journal.items(named)?.length : new FileSessionStore(lane.storeDir).load(named));
    const conversation = kept ? named : undefined;
    const items = conversation ? lane.journal.items(conversation) ?? [] : [];
    lane.options.model = id;
    if (toProgram) {
      delete (lane.options as { session?: string }).session;
      lane.carry = items.length ? items : undefined;
      const again = restartLane(lane, items.length ? transcriptOf(items) : undefined);
      if (!again.ok) { lane.options.model = before.model; if (before.session !== undefined) lane.options.session = before.session; lane.carry = undefined; say(lane, { ev: "error", msg: again.error }); return; }
    } else {
      if (conversation) { await adoptWatched(lane, conversation); lane.options.session = conversation; }
      const again = restartLane(lane);
      if (!again.ok) { lane.options.model = before.model; if (before.session !== undefined) lane.options.session = before.session; say(lane, { ev: "error", msg: again.error }); return; }
      if (conversation) lane.created?.engine.handle({ cmd: "load", id: conversation });
    }
    say(lane, { ev: "notice", msg: handedOver(name) });
  };
  /** A model reached through a program keeps its sessions itself: it is started again on the one asked for, and every window is shown what was said. */
  const openProgramSession = (lane: Lane, id: string): void => {
    if (lane.running) { say(lane, { ev: "error", msg: "Wait for the current reply to finish before opening another conversation." }); return; }
    const items = lane.journal.items(id);
    if (!items) { say(lane, { ev: "error", msg: remote.some((s) => s.id === id) ? "That conversation is in the cloud, not on this computer. Open it from the Cloud group, or bring it to this computer first." : "That conversation was not found." }); return; }
    lane.options.session = id;
    const again = restartLane(lane);
    if (!again.ok) { say(lane, { ev: "error", msg: again.error }); return; }
    say(lane, { ev: "loaded", id, items });
  };
  /** The first search on a computer reads the conversations that were kept before the index existed. */
  const search = (lane: Lane, query: string, limit: number, includeArchived = false): void => {
    const db = searchIndexOf(lane);
    if (!db) { say(lane, { ev: "found", query, items: [] }); return; }
    fillIndex(lane, db);
    const meta = lane.meta.read();
    const hidden = new Set(includeArchived ? [] : meta.archived);
    const mine = new Map(listSessions(lane, false).concat(includeArchived ? listSessions(lane, true) : []).map((s) => [s.id, s]));
    const hits = db.search(query, limit + hidden.size).filter((h) => !hidden.has(h.id)).map((h) => { const row = mine.get(h.id); return { ...h, ...(meta.titles[h.id] ? { title: meta.titles[h.id]! } : {}), ...(row?.project ? { project: row.project } : {}) }; });
    // What the cloud holds is not on this computer, so it is not in the index: its titles are looked at, so it still shows up.
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const seen = new Set(hits.map((h) => h.id));
    for (const s of mine.values()) {
      if (s.where !== "cloud" || seen.has(s.id) || !words.every((w) => s.title.toLowerCase().includes(w))) continue;
      hits.push({ id: s.id, title: s.title, snippet: "", updated: s.updated, where: "cloud", ...(s.project ? { project: s.project } : {}) });
    }
    say(lane, { ev: "found", query, items: hits.slice(0, limit) });
  };
  const noModel = (lane: Lane): string => (/no model is configured|no model is connected yet|several models/.test(lane.error) ? "No model is connected. Run `navvied init`." : `No model is connected: ${lane.error}`);
  const restartLane = (lane: Lane, earlier?: string): { ok: true } | { ok: false; error: string } => {
    lane.created?.engine.close();
    lane.created = undefined;
    const made = engineFor(lane, earlier);
    if (!made.ok) { lane.error = made.error; return { ok: false, error: made.error }; }
    lane.created = made.value;
    if (lane.kind === "agent") folderBook.used(made.value.cwd);
    return { ok: true };
  };

  /** A conversation copied into a new one: same kind, project and place; the title says it is a fork. A page then opens `newId`. */
  const fork = async (lane: Lane, id: string): Promise<void> => {
    const told = (ok: boolean, newId?: string, msg?: string): void => { say(lane, { ev: "forked", id, ...(newId ? { newId } : {}), ok, ...(msg ? { msg } : {}) }); };
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) { told(false, undefined, "That conversation was not found."); return; }
    const newId = randomUUID();
    const all = [...listSessions(lane), ...listSessions(lane, true)];
    const from = all.find((s) => s.id === id);
    const title = `${from?.title ?? "Conversation"} (fork)`.slice(0, 80);
    if (from?.where === "cloud") {
      told(false, undefined, "Bring it to this computer first, then fork it here.");
      return;
    } else {
      const store = new FileSessionStore(lane.storeDir);
      const items = lane.journal.items(id);
      const messages = store.load(id) ?? (items ? messagesOf(items) : null);
      if (!messages?.length) { told(false, undefined, "That conversation was not found on this computer."); return; }
      try { store.save(newId, messages); } catch { told(false, undefined, "The copy could not be saved."); return; }
      if (!lane.journal.copy(id, newId)) lane.journal.write(newId, items ?? historyOf(messages, 400));
      lane.meta.update((m) => { m.titles[newId] = title; });
      try { searchIndexOf(lane)?.put(newId, title, Date.now(), lane.journal.items(newId) ?? historyOf(messages, 400)); } catch { /* the index is a convenience */ }
    }
    relistAll();
    told(true, newId);
  };

  /** New, rename, delete and pin: what a person does to their list of conversations. Every window is given the list again. */
  const manage = (lane: Lane, cmd: Extract<Command, { cmd: "new" | "rename" | "remove" | "pin" | "archive" | "mark" }>): void => {
    const relist = (): void => { say(lane, { ev: "sessions", items: listSessions(lane) }); };
    const fresh = (): boolean => {
      if (lane.running) { say(lane, { ev: "error", msg: "Wait for the current reply to finish first." }); return false; }
      delete (lane.options as { session?: string }).session;
      const again = restartLane(lane);
      if (!again.ok) { say(lane, { ev: "error", msg: again.error }); return false; }
      return true;
    };
    if (cmd.cmd === "new") {
      if (cmd.folder !== undefined) {
        // A folder is named by the id this hub gave it, and by nothing else: a page cannot ask for a path.
        if (lane.kind === "chat") { say(lane, { ev: "error", msg: "A chat has no folder." }); return; }
        const path = folderBook.resolve(cmd.folder, resolve(lane.options.cwd ?? process.cwd()), namedFolders());
        if (!path) { say(lane, { ev: "error", msg: "That folder is not offered by this computer." }); return; }
        if (lane.running) { say(lane, { ev: "error", msg: "Wait for the current reply to finish first." }); return; }
        lane.options.cwd = path;
      }
      if (fresh()) relist();
      return;
    }
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(cmd.id)) { say(lane, { ev: "error", msg: "That conversation was not found." }); return; }
    if (cmd.cmd === "rename") { lane.meta.update((m) => { m.titles[cmd.id] = cmd.title.slice(0, 80); }); relist(); return; }
    if (cmd.cmd === "archive") { lane.meta.update((m) => { m.archived = m.archived.filter((x) => x !== cmd.id); if (cmd.archived) m.archived.push(cmd.id); }); relist(); return; }
    if (cmd.cmd === "mark") {
      lane.meta.update((m) => {
        if (cmd.read === true) m.unread = m.unread.filter((x) => x !== cmd.id);
        if (cmd.read === false && !m.unread.includes(cmd.id)) m.unread.push(cmd.id);
        if (cmd.done !== undefined) { m.done = m.done.filter((x) => x !== cmd.id); if (cmd.done) m.done.push(cmd.id); }
      });
      relist();
      return;
    }
    if (cmd.cmd === "pin") { lane.meta.update((m) => { m.pinned = m.pinned.filter((x) => x !== cmd.id); if (cmd.pinned) m.pinned.push(cmd.id); }); relist(); return; }
    // remove
    if ([...asideSlots].some((s) => s.lane === lane && s.id === cmd.id)) { say(lane, { ev: "error", msg: "Wait for the current reply to finish before deleting this conversation." }); return; }
    const current = lane.created?.engine.sessionId === cmd.id;
    if (current && lane.running) { say(lane, { ev: "error", msg: "Wait for the current reply to finish before deleting this conversation." }); return; }
    try { rmSync(join(lane.storeDir, `${cmd.id}.json`), { force: true }); } catch { /* it was not there */ }
    lane.journal.remove(cmd.id);
    try { searchIndexOf(lane)?.remove(cmd.id); } catch { /* the index is a convenience */ }
    // Nothing of it is left: not its checkpoints, not what it was said to have written, not text typed for it and not sent.
    try { forgetCheckpoints(checkpointsDir(io.env), cmd.id); } catch { /* it had none */ }
    lane.artifacts.forget(cmd.id);
    drafts.set(cmd.id, "");
    lane.meta.update((m) => { delete m.titles[cmd.id]; m.pinned = m.pinned.filter((x) => x !== cmd.id); if (!m.removed.includes(cmd.id)) m.removed.push(cmd.id); });
    // A copy that an earlier version or a hosted session left on the account goes too, whether or not this computer keeps conversations there now.
    const account = signedIn();
    if (account) void deleteConversation(io.fetch, account, cmd.id);
    remote = remote.filter((s) => s.id !== cmd.id);
    if (current && !fresh()) return;
    relist();
  };

  /** What the account holds in the cloud (left by hosted sessions or put there by a person) that this computer does not have yet. */
  const cloudOnly = (): SessionInfo[] => remote.filter((s) => (s.source === "hosted" || s.source === "cloud") && !new FileSessionStore(laneFor(s.kind === "chat" ? "chat" : "agent").storeDir).load(s.id));
  let importableTold = -1;
  const announceImportable = (): void => {
    if (!signedIn()) return;
    const count = cloudOnly().length;
    if (count === importableTold) return;
    importableTold = count;
    say(main, { ev: "importable", count });
  };

  /** The conversation `id` of the cloud, saved on this computer as its kind and indexed. With `remove`, the cloud copy goes after this computer has it. */
  const bringHome = async (account: Account, entry: SessionInfo, remove: boolean): Promise<boolean> => {
    const lane = laneFor(entry.kind === "chat" ? "chat" : "agent");
    const store = new FileSessionStore(lane.storeDir);
    if (!store.load(entry.id)) {
      const full = await getConversation(io.fetch, account, entry.id).catch(() => undefined);
      if (!full?.items.length) return false;
      try { store.save(entry.id, messagesOf(full.items)); } catch { return false; }
      try { searchIndexOf(lane)?.put(entry.id, entry.title, entry.updated, full.items); } catch { /* the index is a convenience */ }
    }
    if (remove) { await deleteConversation(io.fetch, account, entry.id); remote = remote.filter((s) => s.id !== entry.id); }
    return true;
  };
  const relistAll = (): void => { for (const lane of lanes.values()) say(lane, { ev: "sessions", items: listSessions(lane) }); };

  /** The cloud's conversations (all, or the `ids`) brought onto this computer, and removed from the cloud. Only when the person asks. */
  const importHosted = async (ids?: readonly string[]): Promise<number> => {
    const account = signedIn();
    if (!account) return 0;
    let count = 0;
    try {
      await refreshRemote();
      for (const c of cloudOnly()) { if (ids && !ids.includes(c.id)) continue; if (await bringHome(account, c, true)) count++; }
    } catch { /* the account could not be reached: it can be asked again */ }
    importableTold = -1;
    if (count) relistAll();
    announceImportable();
    say(main, { ev: "imported", count });
    return count;
  };

  /** The conversation `id` of this lane as it is kept here (what was said), or nothing. */
  const itemsOf = (lane: Lane, id: string): { items: readonly { k: "user" | "assistant" | "tool"; text: string }[]; project?: string } | undefined => {
    const store = new FileSessionStore(lane.storeDir);
    const messages = store.load(id);
    const items = lane.journal.items(id) ?? (messages ? historyOf(messages, 400) : undefined);
    if (!items?.length) return undefined;
    const project = lane.journal.list(500).find((s) => s.id === id)?.project;
    return { items, ...(project ? { project } : {}) };
  };
  /** A conversation taken off this computer: its saved copy, its record, its search entry, its title and pin. If it is the one in use, a fresh one starts. */
  const dropLocal = (lane: Lane, id: string): void => {
    const current = lane.created?.engine.sessionId === id;
    try { rmSync(join(lane.storeDir, `${id}.json`), { force: true }); } catch { /* it was not there */ }
    lane.journal.remove(id);
    try { searchIndexOf(lane)?.remove(id); } catch { /* the index is a convenience */ }
    lane.meta.update((m) => { delete m.titles[id]; m.pinned = m.pinned.filter((x) => x !== id); });
    if (current) { delete (lane.options as { session?: string }).session; restartLane(lane); }
  };

  /** The computers of the account, with the secret each is reached by. Replaceable, so a test needs no server. */
  const computers = async (): Promise<AccountComputer[]> => {
    if (hubOptions.computers) return hubOptions.computers();
    const account = signedIn();
    return account ? listComputers(io.fetch, account) : [];
  };
  const relayAddress = (): string => hubOptions.relayUrl ?? io.env.NAVVIED_RELAY_URL ?? relayUrlFor(signedIn()?.server ?? "https://navvied.com");

  /** Move or copy a conversation: from the cloud to this computer, or from this computer to another computer of the account. Never to the cloud. */
  const transfer = async (lane: Lane, cmd: Extract<Command, { cmd: "move" | "copy" }>): Promise<void> => {
    const copy = cmd.cmd === "copy";
    const told = (ok: boolean, msg?: string): void => { say(lane, { ev: "moved", id: cmd.id, to: cmd.to, ok, ...(copy ? { copy: true } : {}), ...(msg ? { msg } : {}) }); };
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(cmd.id)) { told(false, "That conversation was not found."); return; }
    if (cmd.to === "cloud") { told(false, "Conversations are never sent to the cloud from a computer."); return; }
    const account = signedIn();
    if (!account) { told(false, "Sign in to move conversations between your computers."); return; }
    if (cmd.to === "this") {
      await refreshRemote().catch(() => false);
      const entry = cloudOnly().find((s) => s.id === cmd.id);
      if (!entry) { told(false, "That conversation is not in the cloud, or is already on this computer."); return; }
      const ok = await bringHome(account, entry, !copy);
      importableTold = -1;
      relistAll(); announceImportable();
      told(ok, ok ? undefined : "The conversation could not be brought here. It is still in the cloud.");
      return;
    }
    // To another computer of the account: sent through the relay, sealed, to be saved there. Nothing passes through, or stays on, the server.
    const found = (await computers().catch(() => [])).find((c) => c.id === cmd.to);
    if (!found) { told(false, "That computer is not on your account."); return; }
    if (found.name === computerName()) { told(false, "That is this computer."); return; }
    const got = itemsOf(lane, cmd.id);
    if (!got) { told(false, "That conversation was not found on this computer."); return; }
    if (!copy && lane.created?.engine.sessionId === cmd.id && lane.running) { told(false, "Wait for the current reply to finish before moving this conversation."); return; }
    const title = lane.meta.read().titles[cmd.id] ?? titleOf(got.items);
    // The conversation goes in parts that fit a relay frame.
    const parts: { k: "user" | "assistant" | "tool"; text: string }[][] = [[]];
    let size = 0;
    for (const item of got.items) {
      if (parts.at(-1)!.length >= 100 || (size > 200_000 && parts.at(-1)!.length)) { parts.push([]); size = 0; }
      parts.at(-1)!.push({ k: item.k, text: item.text.slice(0, 4000) });
      size += item.text.length;
    }
    const sent = await talkToComputer({
      url: relayAddress(), secret: found.secret, timeoutMs: hubOptions.transferMs ?? 30_000,
      send: parts.map((items, part) => ({ cmd: "receive", id: cmd.id, title, ...(got.project ? { project: got.project } : {}), updated: Date.now(), part, parts: parts.length, items, ...(lane.kind === "chat" ? { kind: "chat" } : {}) })),
      until: (e) => (e.ev === "received" && e.id === cmd.id ? { ok: e.ok === true, ...(typeof e.msg === "string" ? { msg: e.msg } : {}) } : undefined),
    });
    if (!sent.ok) {
      told(false, sent.msg === "not-allowed" ? `${found.name} did not allow it.` : sent.msg === "no-answer" ? `${found.name} did not answer in time.` : sent.msg === "unreachable" ? `${found.name} is not reachable.` : `${found.name} could not save it: ${sent.msg ?? "unknown"}.`);
      return;
    }
    if (!copy) { dropLocal(lane, cmd.id); relistAll(); }
    told(true);
  };

  /** Parts of a conversation another computer is sending, by lane and id, until the last has come. */
  const arriving = new Map<string, { parts: ({ k: "user" | "assistant" | "tool"; text: string }[] | undefined)[]; at: number; title: string; project?: string; updated: number }>();
  const receive = (lane: Lane, cmd: Extract<Command, { cmd: "receive" }>): void => {
    const said = (ok: boolean, msg?: string): void => { say(lane, { ev: "received", id: cmd.id, ok, ...(msg ? { msg } : {}) }); };
    const now = Date.now();
    for (const [k, v] of arriving) if (now - v.at > 120_000) arriving.delete(k);
    const key = `${lane.kind}:${cmd.id}`;
    if (!arriving.has(key) && arriving.size >= 4) { said(false, "busy with other conversations"); return; }
    const entry = arriving.get(key) ?? { parts: Array.from({ length: cmd.parts }, () => undefined), at: now, title: cmd.title, ...(cmd.project ? { project: cmd.project } : {}), updated: cmd.updated };
    if (entry.parts.length !== cmd.parts) { arriving.delete(key); said(false, "the parts do not fit together"); return; }
    entry.parts[cmd.part] = cmd.items;
    entry.at = now;
    arriving.set(key, entry);
    if (entry.parts.some((p) => !p)) return;
    arriving.delete(key);
    const items = entry.parts.flat() as { k: "user" | "assistant" | "tool"; text: string }[];
    if (items.length > 400 || !items.length) { said(false, "that conversation is empty or too long"); return; }
    const store = new FileSessionStore(lane.storeDir);
    // Already here: nothing is replaced, and the sender is told it is there.
    if (!store.load(cmd.id) && !lane.journal.items(cmd.id)) {
      try { store.save(cmd.id, messagesOf(items)); } catch { said(false, "it could not be saved"); return; }
      lane.journal.write(cmd.id, items, entry.project);
      if (entry.title !== titleOf(items)) lane.meta.update((m) => { m.titles[cmd.id] = entry.title.slice(0, 80); });
      try { searchIndexOf(lane)?.put(cmd.id, entry.title, entry.updated, items); } catch { /* the index is a convenience */ }
    }
    relistAll();
    said(true);
  };

  // Scheduled tasks: kept in the computer's own file, listed to every window, and (where asked) run while this hub is up.
  const schedules = new ScheduleStore(schedulesPath(io.env));
  const runningJobs = new Set<string>();
  const scheduleItems = (): ScheduleInfo[] => schedules.list().map((j): ScheduleInfo => {
    const cron = parseCron(j.cron);
    const next = j.disabled || typeof cron === "string" ? undefined : nextRun(cron, Date.now());
    const kind: SessionKind = j.kind === "chat" ? "chat" : "agent";
    return { id: j.id, title: j.title ?? (j.prompt.length > 60 ? `${j.prompt.slice(0, 59)}…` : j.prompt), prompt: j.prompt, cron: j.cron, ...(next ? { next } : {}), ...(j.lastRun ? { last: j.lastRun } : {}), ...(j.lastCode !== undefined ? { lastCode: j.lastCode } : {}), enabled: !j.disabled, ...(kind === "agent" ? { folder: { id: folderId(j.cwd), name: basename(j.cwd) || j.cwd } } : {}), kind, mode: j.mode, ...(runningJobs.has(j.id) ? { running: true as const } : {}) };
  });
  const tellSchedules = (): void => { say(main, { ev: "schedules", items: scheduleItems() }); };
  const startJob = (job: Job): void => {
    if (runningJobs.has(job.id)) return;
    runningJobs.add(job.id);
    schedules.markRun(job.id, Date.now());
    tellSchedules();
    void (hubOptions.runner ?? runJob)(job, io.env, scheduledDir(io.env)).then((f) => { schedules.finished(job.id, f.code); }).catch(() => { schedules.finished(job.id, null); }).finally(() => { runningJobs.delete(job.id); tellSchedules(); });
  };
  const tickJobs = (): void => { for (const job of dueJobs(schedules.list(), Date.now())) startJob(job); };
  const jobTimer = hubOptions.schedule ? setInterval(tickJobs, 30_000) : undefined;
  jobTimer?.unref?.();
  if (hubOptions.schedule) queueMicrotask(tickJobs);

  /** The folder a task works in: named by an id this hub gave, or the current one. */
  const jobFolder = (id: string | undefined): string | undefined => (id === undefined ? resolve(main.options.cwd ?? process.cwd()) : folderBook.resolve(id, resolve(main.options.cwd ?? process.cwd()), namedFolders()));
  const schedule = (lane: Lane, cmd: Extract<Command, { cmd: "schedules" | "schedule.add" | "schedule.update" | "schedule.remove" | "schedule.run" }>): void => {
    const fail = (msg: string): void => { say(lane, { ev: "error", msg }); };
    if (cmd.cmd === "schedules") { tellSchedules(); return; }
    if (cmd.cmd === "schedule.add") {
      const chat = cmd.kind === "chat";
      const cwd = chat ? resolve(chatFilesDir(io.env)) : jobFolder(cmd.folder);
      if (!cwd) { fail("That folder is not offered by this computer."); return; }
      const made = schedules.add({ cron: cmd.cron, prompt: cmd.prompt, cwd, ...(cmd.mode ? { mode: cmd.mode } : {}), ...(cmd.title ? { title: cmd.title } : {}), ...(chat ? { kind: "chat" as const } : {}) });
      if (typeof made === "string") { fail(`The task was not saved: ${made}.`); return; }
      tellSchedules();
      return;
    }
    if (cmd.cmd === "schedule.remove") { if (!schedules.remove(cmd.id)) { fail("That task was not found."); return; } tellSchedules(); return; }
    if (cmd.cmd === "schedule.run") { const job = schedules.list().find((j) => j.id === cmd.id); if (!job) { fail("That task was not found."); return; } if (runningJobs.has(job.id)) { fail("That task is already running."); return; } startJob(job); return; }
    // update
    let cwd: string | undefined;
    if (cmd.folder !== undefined) { cwd = jobFolder(cmd.folder); if (!cwd) { fail("That folder is not offered by this computer."); return; } }
    const changed = schedules.update(cmd.id, { ...(cmd.title !== undefined ? { title: cmd.title } : {}), ...(cmd.cron !== undefined ? { cron: cmd.cron } : {}), ...(cmd.prompt !== undefined ? { prompt: cmd.prompt } : {}), ...(cmd.mode ? { mode: cmd.mode } : {}), ...(cwd ? { cwd } : {}), ...(cmd.enabled !== undefined ? { enabled: cmd.enabled } : {}) });
    if (typeof changed === "string") { fail(`The task was not changed: ${changed}.`); return; }
    tellSchedules();
  };

  // What extends the agent here: skills, outside tool servers, hooks. Listed read-only; switching one is kept in the computer's own state.
  const pluginState = new PluginState(pluginStatePath(io.env));
  const toolUsage = new ToolUsage(toolUsagePath(io.env));
  const drafts = new DraftStore(draftsPath(io.env));
  const terminalState = new TerminalState(terminalStatePath(io.env));
  const terminalConfig = () => { const f = loadConfig(configPath(io.env, options.config), io.env); return f.ok ? f.value?.terminal : undefined; };
  const tellTools = (lane: Lane): void => { const items = listTools(pluginState, toolUsage); say(lane, { ev: "tools", items, sets: listSets(items), backends: listBackends(terminalState, terminalConfig()) }); };
  const pluginItems = () => { const f = loadConfig(configPath(io.env, options.config), io.env); return listPlugins(pluginState, f.ok ? f.value : null, join(dirname(configPath(io.env, options.config)), "skills"), resolve(main.options.cwd ?? process.cwd())); };
  const tellProviders = (): void => {
    const file = loadConfig(configPath(io.env, main.options.config));
    const items = reportOf(PROVIDERS, file.ok ? (file.value?.providers ?? {}) : {});
    for (const e of PROVIDERS) {
      if (!e.adc) continue;
      const credential = "file" in findCredentialFile(e.adc, io.env);
      const at = items.findIndex((i) => i.id === e.id);
      if (at >= 0) items[at] = { ...items[at]!, credential }; else items.push({ id: e.id, key: false, credential });
    }
    say(main, { ev: "providers", items });
  };
  const local = localModels({
    io,
    ...(hubOptions.probe ? { probe: hubOptions.probe } : {}),
    inCloud: () => { const f = loadConfig(configPath(io.env, main.options.config)); return !!main.options.sandboxed || (f.ok && !!f.value?.webProxy); },
    hubToken: () => { const f = loadConfig(configPath(io.env, main.options.config)); return f.ok ? f.value?.providers?.[MODEL_HUB.tokenProvider]?.key : undefined; },
    tell: (e) => say(main, e),
    models: {
      add: (name, entry) => { saveModel(configPath(io.env, main.options.config), name, entry); pushModels(); },
      refresh: () => { pushModels(); },
    },
  });
  runningLocal = local.running;
  const tellEndpoints = (): void => {
    const file = loadConfig(configPath(io.env, main.options.config));
    say(main, { ev: "endpoints", items: reportEndpoints(file.ok ? file.value?.endpoints : undefined) });
  };
  const tellPlugins = (): void => { say(main, { ev: "plugins", items: pluginItems() }); };

  const hub: Hub = {
    attach(client, since) {
      if (since > 0) {
        for (const h of history) if (h.seq > since) client.send(h.line);
      } else {
        // A window that knows nothing is given the current conversation of each kind, not the older ones the ring still holds.
        const from = new Map<SessionKind, number>();
        history.forEach((h, i) => { if (h.starts) from.set(h.kind, i); });
        // What each kind can do was said once, early: the latest word on it is given first, wherever it was said.
        const abilities = new Map<SessionKind, number>();
        history.forEach((h, i) => { if (h.caps) abilities.set(h.kind, i); });
        for (const [kind, i] of abilities) if (i < (from.get(kind) ?? 0)) client.send(history[i]!.line);
        history.forEach((h, i) => { if (i >= (from.get(h.kind) ?? 0)) client.send(h.line); });
      }
      // The end of what was missed, also when there was nothing: a page knows from it that it is up to date.
      if (asideSlots.size) client.send(backgroundLine());
      client.send(JSON.stringify({ ev: "synced", version: VERSION, running: [...lanes].filter(([, l]) => l.running).map(([k]) => k) }));
      clients.add(client);
      return () => { clients.delete(client); };
    },
    command(text, reply) {
      const parsed = parseCommand(text);
      if (!parsed.ok) { reply(JSON.stringify({ ev: "error", msg: `bad command: ${parsed.error}` })); return; }
      const lane = laneFor(parsed.value.kind ?? primary);
      // Opening another conversation while one is being answered does not stop it: it goes on in the background, and opening it again brings it back.
      if (parsed.value.cmd === "load") {
        const id = parsed.value.id;
        const there = [...asideSlots].find((s) => s.lane === lane && s.id === id);
        if (there) { bringBack(lane, there); return; }
        if (lane.running && !putAside(lane)) return;
      }
      if (parsed.value.cmd === "new" && lane.running && !putAside(lane)) return;
      // A new conversation makes its own engine: one is not made first just to be replaced.
      const now = parsed.value.cmd === "new" && !lane.created ? undefined : connect(lane);
      if (parsed.value.cmd === "sessions") {
        const archived = parsed.value.archived === true;
        say(lane, { ev: "sessions", items: listSessions(lane, archived) });
        void refreshRemote().then((changed) => { if (changed) say(lane, { ev: "sessions", items: listSessions(lane, archived) }); announceImportable(); });
        return;
      }
      if (parsed.value.cmd === "import") { if (!signedIn()) { say(lane, { ev: "error", msg: "Sign in to bring conversations from the cloud." }); return; } void importHosted(parsed.value.ids); return; }
      if (parsed.value.cmd === "move" || parsed.value.cmd === "copy") { void transfer(lane, parsed.value); return; }
      if (parsed.value.cmd === "schedules" || parsed.value.cmd === "schedule.add" || parsed.value.cmd === "schedule.update" || parsed.value.cmd === "schedule.remove" || parsed.value.cmd === "schedule.run") { schedule(lane, parsed.value); return; }
      if (parsed.value.cmd === "artifacts") { say(lane, { ev: "artifacts", items: lane.artifacts.list(parsed.value.id) }); return; }
      if (parsed.value.cmd === "artifact.read") {
        const got = lane.artifacts.read(parsed.value.id);
        if ("error" in got) { say(lane, { ev: "error", msg: got.error }); return; }
        say(lane, { ev: "artifact", id: got.info.id, name: got.info.name, mime: got.info.mime, bytes: got.info.bytes, ...(got.text !== undefined ? { text: got.text } : {}), ...(got.data !== undefined ? { data: got.data } : {}), ...(got.truncated ? { truncated: true as const } : {}) });
        return;
      }
      if (parsed.value.cmd === "plugins") { tellPlugins(); return; }
      if (parsed.value.cmd === "providers") { tellProviders(); return; }
      if (local.command(parsed.value)) return;
      if (parsed.value.cmd === "endpoints" || parsed.value.cmd === "endpoint.save" || parsed.value.cmd === "endpoint.remove" || parsed.value.cmd === "endpoint.models") {
        const cmd = parsed.value;
        const path = configPath(io.env, main.options.config);
        const file = loadConfig(path);
        const fail = (msg: string): void => { say(lane, { ev: "error", msg }); };
        if (!file.ok) { fail(file.error); return; }
        if (cmd.cmd === "endpoints") { tellEndpoints(); return; }
        if (main.options.sandboxed || file.value?.webProxy) { fail(ONLY_ON_A_COMPUTER); return; }
        const known = file.value?.endpoints ?? {};
        const headersFor = (key: string | undefined) => (api: EndpointRecord["api"]): Record<string, string> => authHeaders(api, key);
        /** What the server speaks: the one asked for, or, for `auto`, the one it answers in. */
        const lookup = async (baseUrl: string, api: "auto" | EndpointRecord["api"], key: string | undefined): Promise<{ api: EndpointRecord["api"]; items: { id: string; window?: number }[] } | { error: string }> => {
          if (api === "auto") {
            const found = await detectApi(io.fetch, baseUrl, headersFor(key), API_STYLES);
            // The style is known now: asked once more in it, which also fills in the sizes the list itself does not say.
            return "error" in found ? found : lookup(baseUrl, found.api, key);
          }
          const got = await askModels(io.fetch, { baseUrl, api, headers: authHeaders(api, key), machine: () => readMachine(realProbe(io.system), localDir(io.env)) });
          return "error" in got ? got : { api, items: got.items };
        };
        if (cmd.cmd === "endpoint.models") {
          const saved = "id" in cmd ? known[cmd.id] : undefined;
          if ("id" in cmd && !saved) { fail("That endpoint is not there."); return; }
          const asked = saved ? { baseUrl: saved.baseUrl, api: saved.api, key: saved.key } : { baseUrl: (cmd as { baseUrl: string }).baseUrl, api: (cmd as { api: "auto" | EndpointRecord["api"] }).api, key: (cmd as { key?: string }).key };
          void lookup(asked.baseUrl, asked.api, asked.key).then((got) => say(lane, "error" in got ? { ev: "error", msg: got.error } : { ev: "endpoint.models", api: got.api, items: got.items }));
          return;
        }
        if (cmd.cmd === "endpoint.remove") {
          if (!known[cmd.id]) { fail("That endpoint is not there."); return; }
          const written = saveEndpoint(path, cmd.id, undefined);
          if (!written.ok) { fail(written.error); return; }
          tellEndpoints();
          pushModels();
          return;
        }
        const id = cmd.id ?? newEndpointId(cmd.name, Object.keys(known));
        const key = cmd.key === undefined ? known[id]?.key : cmd.key === "" ? undefined : cmd.key;
        const keep = (api: EndpointRecord["api"]): void => {
          const written = saveEndpoint(path, id, { name: cmd.name, baseUrl: cmd.baseUrl, api, ...(key ? { key } : {}), models: cmd.models });
          if (!written.ok) { fail(written.error); return; }
          tellEndpoints();
          pushModels();
        };
        // The style is saved as the concrete one it was found to be, never as `auto`.
        if (cmd.api !== "auto") { keep(cmd.api); return; }
        void detectApi(io.fetch, cmd.baseUrl, headersFor(key), API_STYLES).then((got) => { if ("error" in got) fail(got.error); else keep(got.api); });
        return;
      }
      if (parsed.value.cmd === "provider.save" || parsed.value.cmd === "provider.remove" || parsed.value.cmd === "provider.models" || parsed.value.cmd === "provider.use") {
        const cmd = parsed.value;
        const path = configPath(io.env, main.options.config);
        const file = loadConfig(path);
        const fail = (msg: string): void => { say(lane, { ev: "error", msg }); };
        const entry = PROVIDERS.find((p) => p.id === cmd.id);
        if (!file.ok) { fail(file.error); return; }
        if (main.options.sandboxed || file.value?.webProxy) { fail(ONLY_ON_A_COMPUTER); return; }
        if (!entry) { fail("That provider is not known."); return; }
        const before = file.value?.providers?.[entry.id];
        if (cmd.cmd === "provider.save" || cmd.cmd === "provider.remove") {
          const next = cmd.cmd === "provider.remove" ? { saved: undefined } : mergeSaved(entry, before, cmd);
          if ("error" in next) { fail(next.error); return; }
          const commit = (): boolean => {
            const written = saveProvider(path, entry.id, next.saved);
            if (!written.ok) { fail(written.error); return false; }
            tellProviders();
            return true;
          };
          // A new key is tried on the provider's own list of models first: a key it refuses is never kept.
          const where = next.saved && cmd.cmd === "provider.save" && cmd.key !== undefined && !entry.adc ? baseOf(entry, next.saved) : undefined;
          if (!where || !("base" in where) || !next.saved) { commit(); return; }
          const tried = next.saved;
          const headers = { ...(entry.keyHeader ? {} : authHeaders(entry.api, tried.key)), ...headersOf(entry, tried) };
          void listModels(entry, where.base, headers, io.fetch).then((got) => {
            if ("error" in got && got.kind === "refused") { fail(got.error); return; }
            if (commit() && "error" in got && got.kind === "failed") say(lane, { ev: "notice", msg: `${got.error} The key is saved, but it was not checked.` });
          });
          return;
        }
        const saved = before ?? {};
        const where = baseOf(entry, saved);
        if ("missing" in where) { fail(`Add ${where.missing} for ${entry.name} first.`); return; }
        if (!saved.key && !entry.keyOptional && !entry.adc) { fail(`Add a key for ${entry.name} first.`); return; }
        const headers = { ...(entry.keyHeader ? {} : authHeaders(entry.api, saved.key)), ...headersOf(entry, saved) };
        if (cmd.cmd === "provider.models") {
          if (entry.adc) { fail(`${entry.name} has no list of models here: give the name of the model.`); return; }
          void listModels(entry, where.base, headers, io.fetch).then((got) => say(lane, "error" in got ? { ev: "error", msg: got.error } : { ev: "provider.models", id: entry.id, models: got.models.map((m) => m.id), ...(got.skipped.length ? { skipped: got.skipped } : {}) }));
          return;
        }
        const use = (route?: ListedRoute): void => {
          let credential: string | undefined;
          if (entry.adc) {
            const found = findCredentialFile(entry.adc, io.env);
            if ("error" in found) { fail(found.error); return; }
            const usable = checkCredentialFile(found.file);
            if ("error" in usable) { fail(usable.error); return; }
            credential = found.file;
          }
          const session = entry.sessionHeader ? randomUUID() : undefined;
          const made = modelEntryOf(entry, saved, cmd.model, route, session, credential);
          if ("missing" in made) { fail(`Add ${made.missing} for ${entry.name} first.`); return; }
          const name = entryName(entry, cmd.model);
          const written = saveModel(path, name, { provider: entry.id, model: cmd.model, ...(route ? { route } : {}), ...(session ? { session } : {}), ...(credential ? { credential } : {}), window: 128_000, display: { name: cmd.model, brand: entry.name } });
          if (!written.ok) { fail(written.error); return; }
          pushModels();
          switchModel(lane, name);
        };
        if (!entry.routes) { use(); return; }
        void listModels(entry, where.base, headers, io.fetch).then((got) => {
          if ("error" in got) { fail(got.error); return; }
          const listed = got.models.find((m) => m.id === cmd.model);
          if (listed) { use(listed.route); return; }
          const left = got.skipped.find((m) => m.id === cmd.model);
          fail(left ? `${cmd.model}: ${left.reason}.` : `${entry.name} does not list ${cmd.model}.`);
        });
        return;
      }
      if (parsed.value.cmd === "drafts") { reply(JSON.stringify(encoder.stamp({ ev: "drafts", items: drafts.list() }))); return; }
      if (parsed.value.cmd === "draft") {
        drafts.set(parsed.value.key, parsed.value.text);
        // Told to every window at once, but not kept in what a late window is replayed: it asks with `drafts`.
        const line = JSON.stringify(encoder.stamp({ ev: "drafts", items: drafts.list() }));
        for (const c of clients) c.send(line);
        return;
      }
      if (parsed.value.cmd === "tools") { tellTools(lane); return; }
      if (parsed.value.cmd === "tool.toggle") {
        const { name, enabled } = parsed.value;
        const items = listTools(pluginState, toolUsage);
        const names = items.some((t) => t.name === name) ? [name] : listSets(items).find((x) => x.id === name)?.tools;
        if (!names) { say(lane, { ev: "error", msg: "That tool is not one of the agent's." }); return; }
        for (const n of names) pluginState.set(toolId(n), enabled);
        tellTools(lane);
        return;
      }
      if (parsed.value.cmd === "terminal.use") {
        const id = parsed.value.backend;
        const wanted = listBackends(terminalState, terminalConfig()).find((b) => b.id === id);
        if (!wanted?.ready) { say(lane, { ev: "error", msg: wanted?.hint ?? "That place is not available." }); return; }
        terminalState.set(wanted.id);
        tellTools(lane);
        return;
      }
      if (parsed.value.cmd === "plugin.toggle") {
        const id = parsed.value.id;
        if (!pluginItems().some((p) => p.id === id)) { say(lane, { ev: "error", msg: "That is not installed on this computer." }); return; }
        pluginState.set(id, parsed.value.enabled);
        tellPlugins();
        return;
      }
      if (parsed.value.cmd === "receive") { receive(lane, parsed.value); return; }
      if (parsed.value.cmd === "new" || parsed.value.cmd === "rename" || parsed.value.cmd === "remove" || parsed.value.cmd === "pin" || parsed.value.cmd === "archive" || parsed.value.cmd === "mark") { manage(lane, parsed.value); return; }
      if (parsed.value.cmd === "fork") { void fork(lane, parsed.value.id); return; }
      if (parsed.value.cmd === "search") { search(lane, parsed.value.query, parsed.value.limit ?? 10, parsed.value.includeArchived === true); return; }
      if (parsed.value.cmd === "load") { const id = parsed.value.id; if (lane.meta.read().unread.includes(id)) lane.meta.update((m) => { m.unread = m.unread.filter((x) => x !== id); }); }
      if (parsed.value.cmd === "load" && now?.program) { openProgramSession(lane, parsed.value.id); return; }
      if (parsed.value.cmd === "load" && now) { const id = parsed.value.id; void adoptWatched(lane, id).then(() => { lane.created?.engine.handle({ cmd: "load", id }); }); return; }
      if (parsed.value.cmd === "model" && now && lane.engineModels && !lane.engineModels.has(parsed.value.id)) { switchModel(lane, parsed.value.id); return; }
      if (now) now.engine.handle(parsed.value);
      else if (parsed.value.cmd === "prompt") { say(lane, { ev: "error", msg: noModel(lane) }); say(lane, { ev: "done", stop: "error" }); }
    },
    connected: () => connect(main) !== undefined,
    created: () => main.created,
    error: () => main.error,
    cancel() { for (const lane of lanes.values()) lane.created?.engine.handle({ cmd: "cancel" }); for (const slot of asideSlots) slot.created?.engine.handle({ cmd: "cancel" }); },
    restart() {
      // A new model or a new setting reaches every conversation that is open, whatever its kind.
      let result: { ok: true } | { ok: false; error: string } = { ok: true };
      for (const lane of lanes.values()) { if (lane !== main && !lane.created) continue; const again = restartLane(lane); if (lane === main) result = again; }
      return result;
    },
    info() {
      const now = connect(main);
      return { model: now?.modelName ?? null, cwd: now?.cwd ?? resolve(options.cwd ?? process.cwd()), session: now?.engine.sessionId ?? null };
    },
    async stop() {
      // The model server of this computer belongs to this hub: it ends with it.
      await local.stop();
      clearInterval(watching);
      clearInterval(jobTimer);
      for (const slot of asideSlots) { await slot.created?.engine.idle(); slot.created?.engine.close(); }
      asideSlots.clear();
      for (const lane of lanes.values()) { await lane.created?.engine.idle(); lane.created?.engine.close(); try { lane.index?.close(); } catch { /* it was closed */ } lane.index = undefined; }
    },
  };
  return hub;
}
