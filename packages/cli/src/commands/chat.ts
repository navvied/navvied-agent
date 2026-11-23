import { existsSync } from "node:fs";
import { remember } from "@navvied/engine";
import { PERM_MODES, encodeQr, parseEvent, qrText, type CheckpointInfo, type EngineEvent, type PermMode } from "@navvied/protocol";
import type { Options } from "../args.ts";
import { MODE_LABEL, renderBanner } from "../banner.ts";
import { accountPath, configPath, devicesPath, hostedModelsPath, isConfigured, loadConfig, rememberBashPattern, updateConfig, updateStampPath } from "../config.ts";
import { DEFAULT_SERVER, readAccount, writeHostedModels, type Account } from "../account.ts";
import { AccountError, fetchModels } from "../account-client.ts";
import { connectThisComputer, disconnectThisComputer, relayUrlFor } from "../computer.ts";
import { login, signOutScreen } from "../login-ui.ts";
import { autoUpdate } from "./auto-update.ts";
import { makeSuggest } from "../complete.ts";
import { SLASH_COMMANDS } from "../slash.ts";
import type { Created } from "../create.ts";
import { askApproval, askPlan } from "../approval-ui.ts";
import { effortLabel, effortRows, modelRows } from "../model-ui.ts";
import { Presenter } from "../presenter.ts";
import { createHub } from "./hub.ts";
import { hubMenus } from "./hub-menus.ts";
import { computerName } from "../computer.ts";
import { listComputers } from "../account-client.ts";
import { DEFAULT_SITE, askToPair, openWeb, type OpenedWeb } from "./web.ts";
import { DeviceStore } from "../devices.ts";
import { scheduledDir, schedulesPath } from "../config.ts";
import { ScheduleStore } from "../schedules.ts";
import { startDue } from "../schedule-run.ts";
import { deviceRows } from "../devices-ui.ts";
import { RelayHost } from "../relay-host.ts";
import { ensureFile, memoryPathsFor, memoryRows } from "../memory-ui.ts";
import { VERSION } from "../help.ts";
import type { Dock, IO } from "../io.ts";
import { expandMentions, extractAttachments, previewChips } from "../mentions.ts";
import { Renderer, ago, paint } from "../render.ts";
import { ACCENTS, THEMES, currentTheme, isThemeName, parseAccent, resolveTheme, setTheme } from "../theme.ts";
import { setupModel } from "./init.ts";
import { EXIT } from "./run.ts";

/** The file-op verbs already name the file in the title, so repeating the path below it would only be noise. */
const NAMES_ITS_OWN_FILE = /^(Read|Wrote|Changed|Could not (read|write|change))\b/;

/** Every step of a turn in detail: what it did, how long it took, what it ran, what it printed (`room` lines at most per step), and navvied's own quiet notes about it (a folder it left, a job left running). */
function stepsText(log: readonly { title: string; mark: string; ms?: number; input: string; output: string; notes?: string[] }[], color: boolean, room: number): string {
  return log.map((st, i) => {
    const lines = st.output.trimEnd().split("\n");
    const shown = lines.slice(0, room).map((l) => `      ${paint(color, "dim", !Number.isFinite(room) ? l : l.length > 160 ? `${l.slice(0, 159)}…` : l)}`).join("\n");
    const more = lines.length > room ? `\n      ${paint(color, "faint", `… ${lines.length - room} more lines (Ctrl+O or /output shows everything)`)}` : "";
    const ran = st.input && !NAMES_ITS_OWN_FILE.test(st.title) ? `\n   ${paint(color, "dim", "ran:")} ${st.input.replace(/\s+/g, " ").slice(0, 200)}` : "";
    const notes = (st.notes ?? []).map((n) => `\n      ${paint(color, "faint", n)}`).join("");
    return `${paint(color, "bold", `${i + 1}. ${st.mark} ${st.title}`)}${st.ms !== undefined ? paint(color, "dim", `  ${st.ms < 100 ? "<0.1" : (st.ms / 1000).toFixed(1)} s`) : ""}${ran}${st.output.trim() ? `\n${shown}${more}` : ""}${notes}`;
  }).join("\n\n");
}

export const CHAT_HELP = `Commands
${SLASH_COMMANDS.map((c) => `  ${`/${c.name}${c.args ? ` ${c.args}` : ""}`.padEnd(24)}${c.desc}`).join("\n")}

Keys
  Shift+Tab    Switch mode
  Ctrl+O       Read every step of this turn in full (scroll with the arrows; Esc closes)
  Esc          Stop what it is doing (Ctrl+C does too; press it twice to quit)
  PageUp       Scroll back (PageDown comes forward; the mouse wheel works too)
  @ then Tab   Pick a file; its contents are sent along with your message
  y or n       Answer an approval question
  Select text  Hold Fn (Terminal), Option (iTerm2) or Shift (others) while dragging`;

export async function chatCommand(initial: string | undefined, options: Options, io: IO): Promise<number> {
  let mode: PermMode = options.mode ?? "auto";
  let current: Created | undefined;
  const cwd = options.cwd ?? process.cwd();
  const shown = new Map<string, string>();
  const renderer = new Renderer(io, { thinking: options.thinking, status: () => ({ model: current?.modelName ?? "", mode }) });
  const presenter = io.interactive && io.live ? new Presenter(io, renderer, { cwd: () => current?.cwd ?? cwd, thinking: options.thinking, steps: (() => { const f = loadConfig(configPath(io.env, options.config), io.env); return f.ok ? (f.value?.steps ?? "list") : "list"; })(), display: (qid) => shown.get(qid) }) : undefined;
  const view = presenter ?? renderer;
  let before: PermMode = mode === "plan" ? "auto" : mode;
  let busy = false;
  let approval: string | undefined;
  let proposed = false;
  let capsNow: Extract<EngineEvent, { ev: "caps" }> | undefined;
  let switching = false;
  /** The switch under way hands the conversation to a different engine: its own notice already says so in one line, so the generic one below is skipped. */
  let switchingHandover = false;
  let summarised = false;
  /** The effort asked for on the command line, used until the person chooses one in the app. */
  let effortFlag = options.effort;
  let listed: CheckpointInfo[] = [];
  let restoring: string | undefined;
  /** Set when this screen asked for the checkpoint list to open a picker, not just to print it. */
  let checkpointsAsked = false;
  /** Set when this screen asked for the list of conversations, so a list another window asked for does not open a menu here. */
  let listAsked = false;
  /** The words this screen searched for, so a result another window asked for does not open a menu here. */
  let searchAsked: string | undefined;
  const say = (text: string): void => { io.stderr.write(`${text}\n`); };
  let dock: Dock | undefined;
  let updated = false;
  let modes: readonly PermMode[] = PERM_MODES;
  let context: { ctx: number; win: number } | undefined;
  let stopChecking = (): void => {};
  const promptMark = `${paint(io.color, "cyan", "❯")} `;
  const marker = (): void => { if (io.interactive) { dock?.refresh(); io.prompt(promptMark, 'Ask anything, for example: "explain this project"'); } };
  const working = (): void => { if (io.interactive) io.prompt(promptMark, "Working. Type to add instructions, or press Esc to stop."); };

  let menus: ReturnType<typeof hubMenus> | undefined;
  const emit = (e: EngineEvent): void => {
    // A conversation that was put aside while it was being answered goes on without this screen: it only says when it is done, or waits for an answer.
    if ((e as { bg?: string }).bg !== undefined) {
      if (e.ev === "done") say(`${paint(io.color, "cyan", "✓")} A conversation finished in the background. /resume opens it.`);
      else if (e.ev === "approval") say(`${paint(io.color, "yellow", "!")} A conversation in the background waits for your answer. /resume opens it.`);
      return;
    }
    // Another conversation is now the open one: this screen is not waiting for the old one's reply.
    if (e.ev === "session" || e.ev === "loaded") { busy = false; approval = undefined; }
    if (e.ev === "taken") busy = true;
    view.handle(e);
    if (e.ev === "caps") {
      const before = capsNow;
      capsNow = e;
      modes = e.modes;
      // An engine that is made says its abilities first; once it is in place it is the one this screen talks to (a conversation handed to another model has a new one).
      queueMicrotask(() => { current = hub.created() ?? current; });
      const was = before?.models?.find((m) => m.current), now = e.models?.find((m) => m.current);
      if (switching && now && now.id !== was?.id) {
        switching = false;
        // A hand-over says it is one with its own notice (ev:"notice", right after this); nothing more is said here.
        if (switchingHandover) switchingHandover = false;
        else say(`${paint(io.color, "cyan", "✓")} Now using ${paint(io.color, "bold", now.name)}. Your next message goes to it.`);
        if (summarised) say(paint(io.color, "dim", "The conversation was longer than its memory, so the earliest messages were summarised.\nNothing was deleted: /checkpoints still has every change."));
      }
      if (before && e.effort !== before.effort) say(`${paint(io.color, "cyan", "✓")} Effort is now ${e.effort ? effortLabel(e.effort) : "Auto"}. Your next message uses it.`);
      dock?.refresh();
    }
    if (e.ev === "phase" && e.name === "compacting") summarised = true;
    if (e.ev === "usage") { context = { ctx: e.ctx, win: e.win }; dock?.refresh(); }
    if (e.ev === "approval") { approval = e.id; if (presenter && io.choose) void answerApproval(e); }
    if (e.ev === "plan_proposal") proposed = true;
    if (e.ev === "checkpoints") { listed = e.items; if (checkpointsAsked) { checkpointsAsked = false; void chooseCheckpoint(e.items); } }
    if (e.ev === "found" && searchAsked === e.query) { searchAsked = undefined; void chooseHit(e.query, e.items); }
    menus?.onEvent(e);
    if (e.ev === "sessions" && listAsked) { listAsked = false; void menus?.conversations(e.items); }
    if (e.ev === "session") current = hub.created() ?? current;
    if (e.ev === "loaded") current = hub.created() ?? current;
    if (e.ev === "loaded") say(`${paint(io.color, "cyan", "✓")} Opened ${e.items ? `a conversation of ${e.items.length} step${e.items.length === 1 ? "" : "s"}` : "a conversation"}. Your next message continues it.${e.items?.length ? `\n${e.items.slice(-4).map((i) => paint(io.color, "dim", `  ${i.k === "user" ? "you" : i.k === "assistant" ? "navvied" : "tool"}: ${i.text.replace(/\s+/g, " ").slice(0, 100)}`)).join("\n")}` : ""}`);
    if (e.ev === "restore" && e.preview && e.changes.length) {
      restoring = e.id;
      if (presenter && io.choose) void confirmRestore(e);
      else say(`restore ${e.changes.length} file${e.changes.length === 1 ? "" : "s"}? [y/n]`);
    }
    if (e.ev === "restore" && !e.preview) {
      say(e.changes.length
        ? `${paint(io.color, "cyan", "✓")} Restored ${e.changes.length} file${e.changes.length === 1 ? "" : "s"}.${e.undoId ? " The checkpoint from just before is kept too, so /checkpoints can get back to this." : ""}`
        : paint(io.color, "dim", "Nothing changed."));
      marker();
    }
    if (e.ev === "done") { busy = false; approval = undefined; switching = false; if (proposed && mode === "plan" && presenter && io.choose) void answerPlan(); else marker(); }
  };

  /** When this computer is signed in, ask the server what the account may use, so the models stay current. A computer that is offline keeps what it knew. */
  const refreshAccount = async (limitMs?: number): Promise<void> => {
    const account = readAccount(accountPath(io.env, options.config));
    if (!account) return;
    try { writeHostedModels(hostedModelsPath(io.env), await fetchModels(io.fetch, account, limitMs ? AbortSignal.timeout(limitMs) : undefined)); }
    catch (e) { if (e instanceof AccountError && e.message.startsWith("You were signed out")) say(`${paint(io.color, "yellow", "!")} ${e.message}`); }
  };
  // A computer that is signed in but has never listed the models (just updated, or the list was deleted) waits a moment for them,
  // so it does not start by saying that no model is connected.
  if (io.interactive) {
    if (readAccount(accountPath(io.env, options.config)) && !existsSync(hostedModelsPath(io.env))) await refreshAccount(3000);
    else void refreshAccount();
  }
  const hub = createHub(options, io, { watch: false });
  menus = hubMenus({
    io, hub, say, marker, busy: () => busy,
    computers: async () => { const account = readAccount(accountPath(io.env, options.config)); return account ? (await listComputers(io.fetch, account)).filter((c) => c.name !== computerName()).map((c) => ({ id: c.id, name: c.name })) : []; },
  });
  // Tasks the person scheduled run while the app is open, and any that came due while it was closed start once, now.
  if (io.interactive) {
    const schedules = new ScheduleStore(schedulesPath(io.env));
    const tick = (): void => { void startDue(schedules, io.env, scheduledDir(io.env), (f) => say(`${f.code === 0 ? paint(io.color, "cyan", "✓") : paint(io.color, "yellow", "!")} Scheduled task ${f.job.id} ${f.code === 0 ? "finished" : `failed (exit ${f.code})`}: ${f.text.split("\n").find(Boolean)?.slice(0, 120) ?? ""}\n  ${paint(io.color, "dim", `kept in ${f.file}`)}`)); };
    tick();
    setInterval(tick, 30_000).unref?.();
  }
  let web: OpenedWeb | undefined;
  const devices = new DeviceStore(devicesPath(io.env));
  let remote: RelayHost | undefined;
  const relay = (): RelayHost => (remote ??= new RelayHost({ url: io.env.NAVVIED_RELAY_URL ?? relayUrlFor(readAccount(accountPath(io.env, options.config))?.server ?? DEFAULT_SITE), site: options.site ?? io.env.NAVVIED_WEB_URL ?? DEFAULT_SITE, hub, store: devices, ask: (q) => askToPair(io, q), replaced: () => say("Another navvied is now using this computer's link, so this one stopped sharing. Close the other one, or run /remote here again.") }));
  // A signed-in computer is one of the account's computers: a page signed in to the same account finds it and connects, with nothing to pair.
  const joinAccount = async (account: Account): Promise<void> => { await connectThisComputer(io.fetch, account, devices); await relay().start(); };
  const signedIn = io.interactive ? readAccount(accountPath(io.env, options.config)) : undefined;
  if (signedIn) void joinAccount(signedIn).catch(() => relay().start().catch(() => undefined));
  else if (io.interactive && devices.list().some((d) => d.kind === "relay")) void relay().start().catch(() => undefined);
  hub.attach({ send: (line) => { const parsed = parseEvent(String(line)); if (parsed.ok) emit(parsed.value); } }, 0);
  const start = (): boolean => {
    const restarted = hub.restart();
    if (!restarted.ok) { say(`${paint(io.color, "yellow", "!")} ${restarted.error}`); return false; }
    current = hub.created();
    return true;
  };
  if (isConfigured(options, io)) {
    if (!hub.created()) { say(`${paint(io.color, "yellow", "!")} ${hub.error()}`); return EXIT.usage; }
    current = hub.created();
  }
  const welcome = (): void => {
    io.stderr.write(`${renderBanner({
      version: VERSION, cwd: current?.cwd ?? cwd, mode, home: io.env.HOME ?? io.env.USERPROFILE, ...(options.kind === "chat" ? { chat: true } : {}),
      ...(current ? { model: { name: current.modelName, where: current.where }, ...(current.notes.length ? { rules: current.notes } : {}) } : { pickerNext: Boolean(io.choose) }),
    }, io.color, process.stderr.columns)}\n`);
  };
  const footer = (): string => {
    const cols = process.stdout.columns ?? 80;
    const plain = (t: string): number => [...t].length;
    const left = current
      ? [`${paint(io.color, "cyan", paint(io.color, "bold", current.modelName))}`, ...(options.kind === "chat" ? [] : [`${paint(io.color, "dim", MODE_LABEL[mode])}`]), ...(capsNow?.effort ? [paint(io.color, "dim", `Effort ${effortLabel(capsNow.effort)}`)] : []), ...(context && context.win > 0 ? [paint(io.color, "dim", `Context ${Math.min(100, Math.round((context.ctx / context.win) * 100))}%`)] : [])]
      : [paint(io.color, "dim", "No model connected")];
    const keys: [string, string][] = updated ? [] : current
      ? [["/", "commands"], ["@", "files"], ...(modes.length > 1 ? [["Shift+Tab", "mode"] as [string, string]] : [])]
      : [["/model", "connect a model"], ["/", "commands"]];
    const right = updated ? paint(io.color, "green", "✓ Update installed") + paint(io.color, "dim", "   restart to apply") : keys.map(([k, l]) => `${paint(io.color, "cyan", paint(io.color, "bold", k))} ${paint(io.color, "dim", l)}`).join("   ");
    const leftText = left.join("   ");
    const room = cols - 2 - plain(leftText.replace(/\u001b\[[0-9;]*m/g, "")) - plain(right.replace(/\u001b\[[0-9;]*m/g, ""));
    return ` ${leftText}${room >= 2 ? `${" ".repeat(room)}${right}` : ""}`;
  };
  if (io.interactive) {
    dock = io.dock?.(footer);
    welcome();
    const file = loadConfig(configPath(io.env, options.config), io.env);
    const check = (): void => {
      void autoUpdate({ env: io.env, fetch: io.fetch, exe: process.execPath, stamp: updateStampPath(io.env), enabled: file.ok ? file.value?.autoUpdate : undefined }).then((r) => {
        if (r !== "updated") return;
        updated = true;
        clearInterval(timer);
        dock?.refresh();
        if (!dock) say("navvied was updated. Restart to apply.");
      });
    };
    const timer = setInterval(check, 10 * 60 * 1000);
    timer.unref?.();
    stopChecking = () => clearInterval(timer);
    check();
  }

  const answerApproval = async (e: Extract<EngineEvent, { ev: "approval" }>): Promise<void> => {
    const answer = await askApproval(io, e, presenter?.pendingTool, current?.cwd ?? cwd, process.stdout.columns ?? 80);
    approval = undefined;
    if (answer.pattern) {
      const saved = rememberBashPattern(configPath(io.env, options.config), answer.pattern);
      say(saved.ok ? `${paint(io.color, "cyan", "✓")} Will always allow "${answer.pattern}" from now on.` : `${paint(io.color, "yellow", "!")} Could not save that: ${saved.error}`);
    }
    current?.engine.handle({ cmd: "approve", id: e.id, optionId: answer.optionId, ...(answer.input !== undefined ? { input: answer.input } : {}) });
  };

  const answerPlan = async (): Promise<void> => {
    const choice = await askPlan(io);
    if (choice === "build") { setMode(before); send("The plan is approved. Implement it now."); return; }
    if (choice === "change") say("Tell it what to change, then press Enter.");
    marker();
  };

  /** What an `@mention` of a picture or a file comes to: the text without it, the attachment itself, and a line to say about it.
   * Whether the model can see a picture at all is the engine's call (`caps.vision`, or a refusal it already met): it says so with its own `notice`. */
  const attach = (text: string, cwd: string): { text: string; images?: { mime: string; data: string }[]; files?: { name: string; mime: string; data: string }[] } => {
    const a = extractAttachments(text, cwd);
    for (const n of a.notes) say(n);
    return { text: expandMentions(a.text, cwd), ...(a.images.length ? { images: a.images } : {}), ...(a.files.length ? { files: a.files } : {}) };
  };

  const send = (text: string): void => {
    if (!current) return;
    busy = true;
    working();
    proposed = false;
    const qid = crypto.randomUUID();
    shown.set(qid, text);
    current.engine.handle({ cmd: "prompt", ...attach(text, current.cwd), qid, mode, ...(effortFlag ? { effort: effortFlag } : {}) });
  };

  const setMode = (m: PermMode): void => { mode = m; if (m !== "plan") before = m; };
  let quit = false;
  const QUIT = Symbol("quit");
  let wake!: (v: typeof QUIT) => void;
  const quitSignal = new Promise<typeof QUIT>((resolve) => { wake = resolve; });
  const requestQuit = (): void => { quit = true; wake(QUIT); };
  const slash = (line: string): void => {
    const [name = "", arg = ""] = line.slice(1).trim().split(/\s+/, 2);
    switch (name) {
      case "help": say(CHAT_HELP); break;
      case "exit": case "quit": requestQuit(); break;
      case "mode":
        if (PERM_MODES.includes(arg as PermMode)) { setMode(arg as PermMode); say(`Mode: ${MODE_LABEL[mode]}`); }
        else say(`Mode now: ${MODE_LABEL[mode]}. Press Shift+Tab to switch, or type one of: ${PERM_MODES.join(", ")}.`);
        break;
      case "go":
        if (!proposed) { say("there is no plan to approve"); break; }
        setMode(before); send("The plan is approved. Implement it now."); return;
      case "compact": current?.engine.handle({ cmd: "compact" }); busy = true; working(); return;
      case "checkpoints":
        if (io.choose) checkpointsAsked = true;
        current?.engine.handle({ cmd: "checkpoints" });
        break;
      case "restore": {
        const target = listed[Number(arg) - 1];
        if (!listed.length) say("Run /checkpoints first to see the list, then /restore <number>.");
        else if (!target) say(`There is no checkpoint ${arg || "(none given)"}. Pick a number from /checkpoints.`);
        else current?.engine.handle({ cmd: "restore", id: target.id, preview: true });
        break;
      }
      case "clear": if (!current) say("nothing to clear yet"); else if (busy) { hub.command(JSON.stringify({ cmd: "new" }), () => undefined); current = hub.created() ?? current; say("new conversation (the one being answered goes on in the background)"); } else if (start()) say("new conversation"); break;
      case "session": say(current?.engine.sessionId ?? ""); break;
      case "steps": {
        const log = presenter?.steps ?? [];
        if (!log.length) { say("No steps yet in this turn."); break; }
        say(stepsText(log, io.color, 40));
        break;
      }
      case "output": {
        const last = presenter?.lastOutput;
        if (!last) say("No step has printed anything yet.");
        else say(`${paint(io.color, "bold", last.title)}\n${last.text.trimEnd()}`);
        break;
      }
      case "schedule": menus?.schedule(); return;
      case "folder": void menus?.folder(); return;
      case "plugins": menus?.plugins(); return;
      case "tools": menus?.tools(); return;
      case "artifacts": menus?.artifacts(); return;
      case "import": menus?.import(); return;
      case "move": case "copy": menus?.transfer(name as "move" | "copy", arg, current?.engine.sessionId ?? null); return;
      case "search":
        if (!arg.trim()) say("usage: /search <words>   finds earlier conversations by what was said in them");
        else if (!current) say("connect a model first");
        else { searchAsked = arg.trim(); hub.command(JSON.stringify({ cmd: "search", query: arg.trim() }), () => undefined); return; }
        break;
      case "resume": if (!current) say("connect a model first"); else { listAsked = true; hub.command(JSON.stringify({ cmd: "sessions" }), () => undefined); } return;
      case "theme": case "accent": look(name, arg); break;
      case "web": void openPage(); return;
      case "effort": void chooseEffort(); return;
      case "remote": void pairDevice(); return;
      case "memory": void manageMemory(); return;
      case "devices": void manageDevices(); return;
      case "login": case "logout": void accountScreen(name === "logout"); return;
      default: say(`unknown command /${name} — try /help`);
    }
    if (!busy && !quit) marker();
  };

  const stopAndWait = async (): Promise<void> => {
    if (!busy || !current) return;
    current.engine.handle({ cmd: "cancel" });
    await current.engine.idle();
  };

  /** `/resume`: the saved conversations, newest first; choosing one opens it in every window attached to this engine. */
  const chooseSession = async (items: readonly { id: string; title: string; updated: number; messages: number }[]): Promise<void> => {
    if (!io.choose) { say(items.length ? items.map((s, i) => `${i + 1}. ${s.title}`).join("\n") : "no earlier conversations"); marker(); return; }
    if (!items.length) { say("There are no earlier conversations yet."); marker(); return; }
    const ago = (ms: number): string => { const m = Math.max(0, Math.round((Date.now() - ms) / 60_000)); return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };
    const rows = items.map((s) => ({ label: s.title, hint: `${ago(s.updated)}, ${s.messages} messages` }));
    const head = [paint(io.color, "cyan", paint(io.color, "bold", "Open an earlier conversation")), paint(io.color, "dim", "Pick with ↑ ↓ and Enter. Nothing to type.")];
    const answer = await io.choose("Which conversation?", rows, 0, { heading: head });
    const picked = typeof answer === "number" ? items[answer] : undefined;
    if (!picked || !current) { marker(); return; }
    hub.command(JSON.stringify({ cmd: "load", id: picked.id }), () => undefined);
  };

  /** `/search`: the conversations that mention the words, with the passage; choosing one opens it. */
  const chooseHit = async (query: string, hits: readonly { id: string; title: string; snippet: string; updated: number }[]): Promise<void> => {
    if (!hits.length) { say(`Nothing found for "${query}".`); marker(); return; }
    if (!io.choose) { say(hits.map((h, i) => `${i + 1}. ${h.title}\n   ${h.snippet}`).join("\n")); marker(); return; }
    const head = [paint(io.color, "cyan", paint(io.color, "bold", `Found for "${query}"`)), paint(io.color, "dim", "Pick with ↑ ↓ and Enter. The words are in [brackets].")];
    const answer = await io.choose("Which conversation?", hits.map((h) => ({ label: h.title, hint: h.snippet })), 0, { heading: head });
    const picked = typeof answer === "number" ? hits[answer] : undefined;
    if (!picked || !current) { marker(); return; }
    hub.command(JSON.stringify({ cmd: "load", id: picked.id }), () => undefined);
  };

  /** `/checkpoints`: a snapshot sits before each of your messages; choosing one previews what restoring it would change. */
  const chooseCheckpoint = async (items: readonly CheckpointInfo[]): Promise<void> => {
    if (!io.choose) { marker(); return; }
    if (!items.length) { say("No checkpoints yet. One is made automatically before each of your messages."); marker(); return; }
    const rows = items.map((cp) => ({ label: cp.label || cp.id, hint: `${ago(cp.at)}, ${cp.repos.join(", ")}` }));
    const head = [paint(io.color, "cyan", paint(io.color, "bold", "Checkpoints")), paint(io.color, "dim", "Pick one to see what restoring it would change.")];
    const answer = await io.choose("Which checkpoint?", rows, 0, { heading: head });
    const picked = typeof answer === "number" ? items[answer] : undefined;
    if (!picked) { marker(); return; }
    current?.engine.handle({ cmd: "restore", id: picked.id, preview: true });
  };

  /** What `/restore` (or picking a checkpoint) asks before it changes a file: a list of what would happen, then Yes or No. */
  const confirmRestore = async (e: Extract<EngineEvent, { ev: "restore" }>): Promise<void> => {
    const verb = { revert: "Revert", recreate: "Bring back", remove: "Delete" } as const;
    const body = e.changes.slice(0, 12).map((c) => `${verb[c.change]}  ${c.path}`);
    if (e.changes.length > 12) body.push(`… and ${e.changes.length - 12} more`);
    const head = [paint(io.color, "cyan", paint(io.color, "bold", "Restore this checkpoint?")), paint(io.color, "dim", "This changes files in your project; it never touches the conversation.")];
    const answer = await io.choose?.(`Restore ${e.changes.length} file${e.changes.length === 1 ? "" : "s"}?`, [{ label: "Yes, restore" }, { label: "No, keep it as it is" }], 1, { heading: head, body });
    restoring = undefined;
    if (answer === 0) current?.engine.handle({ cmd: "restore", id: e.id });
    else marker();
  };

  const chooseModel = async (): Promise<void> => {
    if (!current || !io.choose) return connect();
    const file = loadConfig(configPath(io.env, options.config), io.env);
    const rows = modelRows(capsNow, current.entry, file.ok ? file.value : null);
    const answer = await io.choose("Which model do you want to use?", rows, Math.max(0, rows.findIndex((r) => r.action.kind === "current")), { numbered: false, ...(busy ? { notice: ["A task is running. A reply that is being written finishes first."] } : {}) });
    const action = typeof answer === "number" ? rows[answer]?.action : undefined;
    if (!action || action.kind === "current") { marker(); return; }
    if (action.kind === "connect") return connect();
    if (action.kind === "switch") {
      switching = true;
      switchingHandover = action.handover;
      summarised = false;
      // Through the hub: a model of the other kind is a hand-over, which it does; one the engine knows is passed on to it. A reply
      // still being written finishes first (the hub itself waits for it), so nothing is stopped here.
      hub.command(JSON.stringify({ cmd: "model", id: action.id }), () => undefined);
      return;
    }
    await stopAndWait();
    options.model = action.name;
    effortFlag = undefined;
    if (start()) {
      dock?.clear();
      welcome();
      say(`${paint(io.color, "cyan", "✓")} Now using ${paint(io.color, "bold", current?.modelName ?? action.name)}. This is a new conversation, because it runs in a different program.`);
    }
    marker();
  };

  const chooseEffort = async (): Promise<void> => {
    if (!capsNow?.efforts?.length) { say("This model has no effort setting. Effort is offered only for models that support it."); marker(); return; }
    const rows = effortRows(capsNow.efforts);
    if (!io.choose) { say(`Levels: ${rows.map((r) => r.level).join(", ")}. Type /effort <level> to choose one.`); marker(); return; }
    const head = [paint(io.color, "cyan", paint(io.color, "bold", "Effort")), paint(io.color, "dim", "Pick with ↑ ↓ and Enter. Applies from your next message.")];
    const answer = await io.choose("How hard should it think?", rows, Math.max(0, rows.findIndex((r) => r.level === (capsNow?.effort ?? "auto"))), { heading: head });
    const row = typeof answer === "number" ? rows[answer] : undefined;
    if (row) { effortFlag = undefined; current?.engine.handle({ cmd: "effort", level: row.level }); }
    marker();
  };

  /** `/login` and `/logout`: the account of this computer. Signing in adds the models we host to `/model`. */
  const accountScreen = async (logout: boolean): Promise<void> => {
    if (!io.choose || !io.text || !io.secret || !io.work) { say("Signing in needs a terminal. Run navvied in a terminal and type /login."); marker(); return; }
    const paths = {
      account: accountPath(io.env, options.config), models: hostedModelsPath(io.env),
      onSignedIn: joinAccount,
      onSignOut: (a: Account) => disconnectThisComputer(io.fetch, a, devices, (id) => relay().forget(id)),
    };
    const account = readAccount(paths.account);
    if (logout && !account) { say("You are not signed in."); marker(); return; }
    const c = io.color;
    const outcome = logout && account ? await signOutScreen(io, account, paths) : await login(io, paths, account, io.env.NAVVIED_SERVER ?? DEFAULT_SERVER);
    if (outcome.kind === "choose-model") return chooseModel();
    if (outcome.kind === "signed-in") {
      const names = outcome.models;
      say(`${paint(c, "cyan", "✓")} Signed in as ${paint(c, "bold", outcome.email)}.${names.length ? ` ${names.join(", ")} ${names.length === 1 ? "is" : "are"} ready.` : ""} Type /model to choose one.`);
    } else if (outcome.kind === "signed-out") say(`${paint(c, "cyan", "✓")} Signed out. Your files and conversations on this computer are untouched.`);
    marker();
  };

  /** The link as a code a phone camera reads, drawn under it (light on a dark terminal, as most are). Nothing when it cannot be made. */
  const qrUnder = (link: string): string => {
    try { return `\n\n${qrText(encodeQr(link)).split("\n").map((l) => `  ${l}`).join("\n")}`; } catch { return ""; }
  };
  const pairDevice = async (): Promise<void> => {
    const made = await relay().pair(`Device ${devices.list().filter((d) => d.kind === "relay").length + 1}`).catch((e: Error) => e);
    if (made instanceof Error) say(`${paint(io.color, "yellow", "!")} ${made.message}`);
    else {
      const c = io.color;
      say(`${paint(c, "cyan", "✓")} Open this address on the other device. It carries the key, so keep it private:\n\n  ${paint(c, "bold", made.link)}${qrUnder(made.link)}\n\n  Check that it shows this code: ${paint(c, "bold", made.code)}\n  ${paint(c, "dim", `It works for ${Math.round(made.expiresInSeconds / 60)} minutes. You will be asked here before it connects.`)}`);
    }
    marker();
  };

  const manageMemory = async (): Promise<void> => {
    const dir = current?.cwd ?? cwd;
    const paths = memoryPathsFor(dir, configPath(io.env, options.config));
    const rows = memoryRows(paths, dir);
    if (!io.choose) { say(rows.map((r) => `${r.label}: ${r.hint ?? ""}`).join("\n")); marker(); return; }
    const head = [paint(io.color, "cyan", paint(io.color, "bold", "Memory")), paint(io.color, "dim", "navvied reads these at the start of every conversation.")];
    const picked = await io.choose("What should it remember?", rows.map(({ label, hint }) => ({ label, ...(hint ? { hint } : {}) })), 0, { heading: head });
    const action = typeof picked === "number" ? rows[picked]?.action : undefined;
    if (action?.kind === "open") { ensureFile(action.file, action.header); io.system.open(action.file); say(`Opened ${paint(io.color, "dim", action.file)}`); }
    else if (action?.kind === "add") {
      const note = await io.text?.("What should it remember?", "", { heading: head });
      if (typeof note === "string" && note.trim()) say(remember(paths, "project", note, new Date().toISOString().slice(0, 10)).replace(/^Remembered/, `${paint(io.color, "cyan", "✓")} Remembered`));
    }
    marker();
  };

  const manageDevices = async (): Promise<void> => {
    const rows = deviceRows(devices.list(), Date.now());
    if (!rows.length) { say("No website or device has been allowed yet. /web opens this conversation in a browser, and /remote does it for another device."); marker(); return; }
    if (!io.choose) { say(rows.map((r) => `${r.label}  ${r.hint ?? ""}`).join("\n")); marker(); return; }
    const head = [paint(io.color, "cyan", paint(io.color, "bold", "Websites and devices")), paint(io.color, "dim", "Choose one to remove it. It will have to ask again.")];
    const picked = await io.choose("Which one?", rows.map(({ label, hint }) => ({ label, ...(hint ? { hint } : {}) })), 0, { heading: head });
    const row = typeof picked === "number" ? rows[picked] : undefined;
    if (row) {
      const sure = await io.choose(`Remove ${row.label}?`, [{ label: "Yes, remove it", hint: "Your conversations are not deleted." }, { label: "No" }], 1, { heading: head });
      if (sure === 0) { remote?.forget(row.id); devices.remove(row.id); say(`${paint(io.color, "cyan", "✓")} Removed ${row.label}.`); }
    }
    marker();
  };

  const openPage = async (): Promise<void> => {
    if (web) { io.system.open(web.link); say(`The page is open. It shows this conversation: ${paint(io.color, "dim", web.site)}`); marker(); return; }
    const opened = await openWeb(options, io, hub, devices);
    if (!opened.ok) say(`${paint(io.color, "yellow", "!")} ${opened.error}`);
    else {
      web = opened.opened;
      say(`Opening ${paint(io.color, "bold", web.site)} in your browser. It will ask you here before it connects.\nIt shows this same conversation, so you can keep going there.`);
    }
    marker();
  };

  const look = (name: string, arg: string): void => {
    const path = configPath(io.env, options.config);
    const theme = currentTheme();
    if (name === "theme" && !isThemeName(arg)) { say(`Themes: ${Object.entries(THEMES).map(([n, t]) => `${n} (${t.hint})`).join(", ")}.\nNow using ${theme.name}. Type /theme <name> to switch.`); return; }
    if (name === "accent" && arg !== "reset" && !parseAccent(arg)) { say(`Accents: ${Object.keys(ACCENTS).join(", ")}, or a #rrggbb colour.\nNow using ${theme.accent}. Type /accent <name>, or /accent reset to go back to the theme's own.`); return; }
    const patch = name === "theme" ? { theme: arg } : { accent: arg === "reset" ? undefined : parseAccent(arg) };
    const saved = updateConfig(path, patch);
    if (!saved.ok) { say(`${paint(io.color, "yellow", "!")} ${saved.error}`); return; }
    setTheme(resolveTheme(saved.value, io.env));
    say(`${paint(io.color, "cyan", "●")} ${name} is now ${arg}`);
  };

  let interrupts = 0;
  const off = io.onInterrupt(() => {
    if (busy && interrupts === 0) { interrupts = 1; current?.engine.handle({ cmd: "cancel" }); say("cancelling…"); setTimeout(() => { interrupts = 0; }, 2000).unref?.(); }
    else requestQuit();
  });

  const runSetup = async (): Promise<boolean> => {
    const next = async (): Promise<string | undefined> => { const r = await Promise.race([input.next(), quitSignal]); return r === QUIT || r.done ? undefined : r.value; };
    return (await setupModel(options, io, next, false)) === EXIT.ok && start();
  };

  const connect = async (pending?: string): Promise<void> => {
    if (pending !== undefined) say(`${paint(io.color, "yellow", "No model is connected yet.")} Let's set one up first, then I'll send your message.\n`);
    if (await runSetup()) {
      if (dock) {
        dock.clear();
        welcome();
        if (pending !== undefined) io.stderr.write(`${promptMark}${pending}\n`);
      }
      if (pending !== undefined) send(pending); else marker();
    }
    else if (!quit) {
      if (io.choose) {
        const again = await io.choose("Not connected yet", [{ label: "Try again" }, { label: "Not now" }], 0, { notice: ["Setup was closed before a model was chosen."] });
        if (again === 0) return connect(pending);
      } else say("Not connected. Run navvied init to try again.");
      marker();
    }
  };

  const offKeys = io.keys?.((key) => {
    if (key === "ctrl-o") {
      // The usual key for the full detail: every step of this turn in full, on a page that can be scrolled and that keeps following while work goes on.
      if (!io.view) { say("Ctrl+O needs the whole-screen view; /steps lists the steps."); return; }
      if (!presenter?.steps.length) { say("No steps yet in this turn."); return; }
      void io.view("Steps of this turn  (Ctrl+O or Esc closes)", () => stepsText(presenter?.steps ?? [], io.color, Infinity).split("\n"));
      return;
    }
    if (key === "escape") {
      if (busy && interrupts === 0) { current?.engine.handle({ cmd: "cancel" }); say("cancelling…"); }
      return;
    }
    const next = modes[(modes.indexOf(mode) + 1) % modes.length];
    if (!next || next === mode) return;
    setMode(next);
    if (dock) dock.refresh(); else say(`Mode: ${MODE_LABEL[next]}`);
    if (!busy) marker();
  });

  const answerOrSend = (line: string): void | Promise<void> => {
    if (!line.trim()) { if (!current && !busy) return connect(); marker(); return; }
    if (restoring && /^(y|yes|n|no)$/i.test(line)) {
      if (/^y/i.test(line)) current?.engine.handle({ cmd: "restore", id: restoring }); else say("not restored");
      restoring = undefined;
      marker();
    } else if (approval && /^(y|yes|n|no)$/i.test(line)) {
      current?.engine.handle({ cmd: "approve", id: approval, optionId: /^y/i.test(line) ? "allow" : "deny" });
      approval = undefined;
    } else if (/^\/model\s*$/.test(line)) return chooseModel();
    else if (/^\/(connect|setup)\s*$/.test(line)) return busy ? say("wait for the current turn to finish") : connect();
    else if (line.startsWith("/")) slash(line);
    else if (!current) return connect(line);
    else if (busy) {
      const qid = crypto.randomUUID();
      shown.set(qid, line);
      presenter?.queue(qid, line);
      current?.engine.handle({ cmd: "prompt", ...(current ? attach(line, current.cwd) : { text: line }), qid, mode });
    }
    else send(line);
  };

  const echo = (line: string): string | undefined => (line.startsWith("/") || !current ? `${promptMark}${paint(io.color, "dim", line)}\n` : undefined);
  const input = io.lines({ suggest: makeSuggest(SLASH_COMMANDS, current?.cwd ?? cwd), chips: (text) => previewChips(text, current?.cwd ?? cwd), ...(presenter ? { echo } : {}) })[Symbol.asyncIterator]();
  if (initial) { if (current) send(initial); else await connect(initial); }
  else if (!current && io.choose) await connect();
  else marker();
  while (!quit) {
    const next = await Promise.race([input.next(), quitSignal]); // a Ctrl+C must not wait for the next keystroke
    if (next === QUIT || next.done) break;
    await answerOrSend(next.value);
  }

  if (quit && busy) current?.engine.handle({ cmd: "cancel" });
  off();
  offKeys?.();
  presenter?.stop();
  await web?.server.stop();
  remote?.stop();
  await hub.stop();
  stopChecking();
  dock?.release();
  return EXIT.ok;
}
