/**
 * What the web page does with the hub, in the terminal: the list of conversations with what can be done to each (open, pin, rename, fork,
 * archive, delete, move to another computer, bring home from the cloud), the folders an agent may work in, the things that extend the agent
 * (skills, tool servers, hooks), the files a conversation wrote, scheduled tasks, and the conversations waiting in the cloud. Each is a
 * command to the hub and a menu for its answer: the hub does the work, so the terminal, the page and the phone behave the same.
 */
import type { EngineEvent, ScheduleInfo, SessionInfo } from "@navvied/protocol";
import type { Hub } from "./hub.ts";
import type { IO } from "../io.ts";
import { paint } from "../render.ts";
import { HubLink } from "../providers/link.ts";
import { Kit } from "../providers/kit.ts";
import { providersScreen } from "../providers/index.ts";
import { toolsScreen } from "../tools-screen.ts";

type Say = (text: string) => void;
type Row = { label: string; hint?: string };

export interface MenuContext {
  io: IO;
  hub: Hub;
  say: Say;
  /** Shows the prompt again when a menu is over. */
  marker: () => void;
  /** Whether a reply is being written now (nothing is changed under it). */
  busy: () => boolean;
  /** The other computers of the account (empty when signed out or the list cannot be had). */
  computers: () => Promise<{ id: string; name: string }[]>;
  /** A model is about to be switched to: the screen says so when the hub confirms it. */
  switching: (handover: boolean) => void;
}

const ago = (ms: number): string => { const m = Math.max(0, Math.round((Date.now() - ms) / 60_000)); return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };
const when = (ms: number | undefined): string => (ms === undefined ? "never" : new Date(ms).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit", day: "numeric", month: "short" }));
const bytes = (n: number): string => (n < 1024 ? `${n} B` : n < 1_048_576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1_048_576).toFixed(1)} MB`);

export function hubMenus(c: MenuContext) {
  const { io, hub } = c;
  const send = (cmd: object): void => hub.command(JSON.stringify(cmd), () => undefined);
  const link = new HubLink(send);
  /** Sends a command and runs `then` on the next event of that name. */
  const ask = <E extends EngineEvent["ev"]>(ev: E, cmd: object, then: (e: Extract<EngineEvent, { ev: E }>) => void): void => link.ask(ev, cmd, then);
  const choose = async (title: string, heading: string, rows: Row[]): Promise<number | undefined> => {
    if (!io.choose) { c.say(`${heading}\n${rows.map((r, i) => `${i + 1}. ${r.label}${r.hint ? `  ${r.hint}` : ""}`).join("\n")}`); return undefined; }
    const answer = await io.choose(title, rows, 0, { heading: [paint(io.color, "cyan", paint(io.color, "bold", heading)), paint(io.color, "dim", "Pick with ↑ ↓ and Enter. Esc goes back.")] });
    return typeof answer === "number" ? answer : undefined;
  };
  const dim = (t: string): string => paint(io.color, "dim", t);

  let caps: { folders?: { id: string; name: string; path?: string; current?: true }[] } = {};
  let cloudWaiting = 0;

  /** The conversations, each with what can be done to it. */
  const conversations = async (items: readonly SessionInfo[]): Promise<void> => {
    if (!items.length) { c.say("There are no earlier conversations yet."); c.marker(); return; }
    const mark = (s: SessionInfo): string => [s.pinned ? "★" : "", s.unread ? "●" : "", s.done ? "✓" : "", s.where === "cloud" ? "cloud" : ""].filter(Boolean).join(" ");
    const rows = items.map((s) => ({ label: `${mark(s) ? `${mark(s)}  ` : ""}${s.title}`, hint: `${ago(s.updated)}${s.project ? `, ${s.project}` : ""}` }));
    const picked = await choose("Which conversation?", "Earlier conversations", rows);
    const s = picked === undefined ? undefined : items[picked];
    if (!s) { c.marker(); return; }
    await rowActions(s);
  };

  const rowActions = async (s: SessionInfo): Promise<void> => {
    const cloud = s.where === "cloud";
    const actions: { label: string; hint?: string; run: () => void | Promise<void> }[] = cloud
      ? [
        { label: "Bring to this computer", hint: "it leaves the cloud", run: () => send({ cmd: "move", id: s.id, to: "this" }) },
        { label: "Copy to this computer", hint: "it stays in the cloud", run: () => send({ cmd: "copy", id: s.id, to: "this" }) },
        { label: "Open it here to read", run: () => send({ cmd: "load", id: s.id }) },
        { label: "Delete", run: () => send({ cmd: "remove", id: s.id }) },
      ]
      : [
        { label: "Open it and keep going", run: () => send({ cmd: "load", id: s.id }) },
        { label: s.pinned ? "Unpin" : "Pin to the top", run: () => send({ cmd: "pin", id: s.id, pinned: !s.pinned }) },
        { label: "Rename", run: async () => { const t = await io.text?.("New name", s.title); if (typeof t === "string" && t.trim()) send({ cmd: "rename", id: s.id, title: t.trim() }); } },
        { label: s.unread ? "Mark as read" : "Mark as unread", run: () => send({ cmd: "mark", id: s.id, read: !!s.unread }) },
        { label: s.done ? "Mark as not done" : "Mark as done", run: () => send({ cmd: "mark", id: s.id, done: !s.done }) },
        { label: "Fork", hint: "a copy to go another way with", run: () => ask("forked", { cmd: "fork", id: s.id }, (e) => { if (e.ok && e.newId) send({ cmd: "load", id: e.newId }); else c.say(e.msg ?? "It could not be forked."); }) },
        { label: s.archived ? "Bring back from the archive" : "Archive", run: () => send({ cmd: "archive", id: s.id, archived: !s.archived }) },
        { label: "Move to another computer…", hint: "copy keeps it here too", run: () => moveToComputer(s) },
        { label: "Delete", run: () => send({ cmd: "remove", id: s.id }) },
      ];
    const picked = await choose(s.title, s.title, actions.map(({ label, hint }) => ({ label, ...(hint ? { hint } : {}) })));
    const action = picked === undefined ? undefined : actions[picked];
    if (!action) { c.marker(); return; }
    if (action.label === "Delete" && io.choose) {
      const sure = await io.choose("Delete this conversation for good?", [{ label: "No, keep it" }, { label: "Yes, delete it" }], 0, { heading: [paint(io.color, "yellow", paint(io.color, "bold", "Delete this conversation?")), dim(s.title)] });
      if (sure !== 1) { c.marker(); return; }
    }
    await action.run();
    if (action.label !== "Open it and keep going" && action.label !== "Open it here to read") c.marker();
  };

  const moveToComputer = async (s: SessionInfo): Promise<void> => {
    const others = await c.computers().catch(() => []);
    if (!others.length) { c.say("There is no other computer on your account. Sign in on this computer (/login) and on the other one, then try again."); return; }
    const picked = await choose("Which computer?", "Send it to", others.map((o) => ({ label: o.name })));
    const to = picked === undefined ? undefined : others[picked];
    if (!to) return;
    const how = await choose("Move or copy?", `${s.title}`, [{ label: "Move", hint: "it leaves this computer once the other has it" }, { label: "Copy", hint: "it stays here too" }]);
    if (how === undefined) return;
    c.say(dim(`Sending to ${to.name}…`));
    send({ cmd: how === 0 ? "move" : "copy", id: s.id, to: to.id });
  };

  const parse = (arg: string): string[] => arg.trim().split(/\s+/).filter(Boolean);

  return {
    /** What the hub said, for a menu that was waiting for it. Returns true when the event was a menu's answer. */
    onEvent(e: EngineEvent): boolean {
      if (e.ev === "caps") caps = { ...(e.folders ? { folders: e.folders } : {}) };
      if (e.ev === "importable") { const before = cloudWaiting; cloudWaiting = e.count; if (e.count > 0 && e.count !== before) c.say(`${paint(io.color, "cyan", "●")} ${e.count} conversation${e.count === 1 ? "" : "s"} from the cloud can be brought to this computer: /import`); }
      if (e.ev === "imported") c.say(e.count ? `${paint(io.color, "cyan", "✓")} Brought ${e.count} conversation${e.count === 1 ? "" : "s"} to this computer. /resume lists them.` : "Nothing was waiting in the cloud.");
      if (e.ev === "moved") c.say(e.ok ? `${paint(io.color, "cyan", "✓")} ${e.copy ? "Copied." : "Moved."}` : `${paint(io.color, "yellow", "!")} ${e.msg ?? "It could not be moved."}`);
      if (e.ev === "forked" && !e.ok) c.say(`${paint(io.color, "yellow", "!")} ${e.msg ?? "It could not be forked."}`);
      return link.onEvent(e);
    },

    /** `/providers`: API keys, endpoints of one's own and models that run on this computer. */
    providers(): Promise<"back" | "switched"> {
      return providersScreen(new Kit(io, link, c.say, c.switching));
    },

    conversations,

    /** `/folder`: choose the folder the next conversation works in. */
    async folder(): Promise<void> {
      const folders = caps.folders ?? [];
      if (c.busy()) { c.say("Wait for the current reply to finish first."); return; }
      if (folders.length < 2) { c.say(folders.length ? `Only this folder is offered: ${folders[0]!.path ?? folders[0]!.name}. Add more in config.json ("folders": [...]) or by working in them.` : "No folders are offered here."); c.marker(); return; }
      const picked = await choose("Which folder?", "Where should the next conversation work?", folders.map((f) => ({ label: f.name, hint: `${f.path ?? ""}${f.current ? "  (now)" : ""}` })));
      const f = picked === undefined ? undefined : folders[picked];
      if (!f || f.current) { c.marker(); return; }
      send({ cmd: "new", folder: f.id });
      c.say(`${paint(io.color, "cyan", "✓")} A new conversation starts in ${paint(io.color, "bold", f.path ?? f.name)}.`);
    },

    /** `/plugins`: what extends the agent here, and switching each on or off. */
    plugins(): void {
      ask("plugins", { cmd: "plugins" }, async (e) => {
        if (!e.items.length) { c.say("No skills, tool servers or hooks are set up. Skills are folders with a SKILL.md in ~/.config/navvied/skills; tool servers (mcp) and hooks go in config.json."); c.marker(); return; }
        const rows = e.items.map((p) => ({ label: `${p.enabled ? "on " : "off"}  ${p.kind}  ${p.name}`, hint: p.description }));
        const picked = await choose("Switch which?", "Skills, tool servers and hooks (Enter switches one)", rows);
        const p = picked === undefined ? undefined : e.items[picked];
        if (!p) { c.marker(); return; }
        send({ cmd: "plugin.toggle", id: p.id, enabled: !p.enabled });
        c.say(`${paint(io.color, "cyan", "✓")} ${p.name} is now ${p.enabled ? "off" : "on"}${p.fromNext ? " (from the next new conversation)" : ""}.`);
        c.marker();
      });
    },

    /** `/tools`: every tool with its own switch, under its heading, and where commands run. */
    async tools(): Promise<void> {
      await toolsScreen(new Kit(io, link, c.say, c.switching));
      c.marker();
    },

    /** `/artifacts`: the files this computer's conversations wrote, and showing one. */
    artifacts(): void {
      ask("artifacts", { cmd: "artifacts" }, async (e) => {
        if (!e.items.length) { c.say("No conversation has written a file yet."); c.marker(); return; }
        const picked = await choose("Show which file?", "Files conversations wrote", e.items.map((a) => ({ label: a.name, hint: `${bytes(a.bytes)}, ${ago(a.updated)}${a.path ? `, ${a.path}` : ""}` })));
        const a = picked === undefined ? undefined : e.items[picked];
        if (!a) { c.marker(); return; }
        ask("artifact", { cmd: "artifact.read", id: a.id }, (f) => {
          if (f.text !== undefined) c.say(`${paint(io.color, "bold", f.name)}${f.truncated ? dim("  (the first 1 MB)") : ""}\n${f.text.trimEnd()}`);
          else c.say(`${paint(io.color, "bold", f.name)}  ${dim(`${f.mime}, ${bytes(f.bytes)}: a picture. Open it from ${a.path ?? "its folder"}.`)}`);
          c.marker();
        });
      });
      // A file that cannot be shown comes back as an error: the terminal's own error line says why.
    },

    /** `/schedule`: the tasks, each with when it runs next, and what can be done to one. */
    schedule(): void {
      ask("schedules", { cmd: "schedules" }, async (e) => {
        if (!e.items.length) { c.say('No scheduled tasks. Add one with: navvied schedule add "0 9 * * 1-5" "summarise yesterday\'s commits"'); c.marker(); return; }
        const rows = e.items.map((j: ScheduleInfo) => ({ label: `${j.enabled ? "on " : "off"}  ${j.title}`, hint: `${j.cron}${j.next ? `  next ${when(j.next)}` : ""}${j.lastCode === undefined ? "" : j.lastCode === 0 ? "  last ran fine" : "  last run failed"}${j.running ? "  running now" : ""}` }));
        const picked = await choose("Which task?", `Scheduled tasks. They run only while this computer is on and navvied is running.`, rows);
        const j = picked === undefined ? undefined : e.items[picked];
        if (!j) { c.marker(); return; }
        const actions = [
          { label: "Run it now", run: () => send({ cmd: "schedule.run", id: j.id }) },
          { label: j.enabled ? "Turn it off" : "Turn it on", run: () => send({ cmd: "schedule.update", id: j.id, enabled: !j.enabled }) },
          { label: "Remove it", run: () => send({ cmd: "schedule.remove", id: j.id }) },
        ];
        const which = await choose(j.title, j.title, actions.map((a) => ({ label: a.label })));
        const action = which === undefined ? undefined : actions[which];
        if (action) { action.run(); c.say(`${paint(io.color, "cyan", "✓")} ${action.label.replace(/^./, (ch) => ch.toUpperCase())}.`); }
        c.marker();
      });
    },

    /** `/import`: the conversations waiting in the cloud, brought here. */
    import(): void { send({ cmd: "import" }); },

    /** `/move <computer id>` and `/copy <computer id>` for the conversation in use. */
    transfer(kind: "move" | "copy", arg: string, sessionId: string | null): void {
      const [to] = parse(arg);
      if (!sessionId) { c.say("There is no conversation open yet."); return; }
      if (!to) { c.say(`usage: /${kind} <computer id>   (the ids are on navvied.com, in your computers)`); return; }
      send({ cmd: kind, id: sessionId, to });
    },
  };
}
