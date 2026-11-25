import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PluginLock, loadPacks, packCommands, type PackCommand, loadSkills, packDirs, projectDirs, type HookConfig, type McpServerConfig, type Pack, type SkillInfo } from "@navvied/engine";
import type { PluginInfo } from "@navvied/protocol";
import type { ConfigFile } from "./config.ts";
import { SKILL_FOLDERS } from "./presets.ts";

export type { PluginInfo };

/** What the person switched off, kept in the computer's own state (the files and the configuration are never touched). */
export class PluginState {
  constructor(private readonly file: string) {}
  #read(): { disabled: Set<string>; enabled: Set<string> } {
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as { disabled?: unknown; enabled?: unknown };
      const list = (v: unknown): Set<string> => new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
      return { disabled: list(raw.disabled), enabled: list(raw.enabled) };
    } catch { return { disabled: new Set(), enabled: new Set() }; }
  }
  #write(state: { disabled: Set<string>; enabled: Set<string> }): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: 1, disabled: [...state.disabled].slice(-500), enabled: [...state.enabled].slice(-500) }));
      renameSync(tmp, this.file);
    } catch { /* a full disk must not stop the work */ }
  }
  disabled(): Set<string> { return this.#read().disabled; }
  /** What the person switched on although it is off until then (an experimental tool). */
  enabledExplicitly(): Set<string> { return this.#read().enabled; }
  set(id: string, enabled: boolean): void {
    const state = this.#read();
    if (enabled) { state.disabled.delete(id); state.enabled.add(id); } else { state.enabled.delete(id); state.disabled.add(id); }
    this.#write(state);
  }
  /** Takes back what was said about it, either way. */
  forget(id: string): void {
    const state = this.#read();
    if (state.disabled.delete(id) || state.enabled.delete(id)) this.#write(state);
  }
}

export const hookId = (event: string, index: number): string => `hook:${event}:${index}`;
export const skillId = (name: string): string => `skill:${name}`;
export const mcpId = (name: string): string => `mcp:${name}`;
export const pluginId = (name: string): string => `plugin:${name}`;

/** Every folder a project's skills may be in, from the outermost folder in, so an inner skill replaces an outer one of the same name. */
export const projectSkillDirs = (cwd: string): string[] => projectDirs(cwd).flatMap((d) => SKILL_FOLDERS.map((f) => join(d, ...f.split("/"))));

/**
 * Which skills that come with a project the person has accepted. A skill is accepted as it is: the fingerprint of its text is
 * what is kept, so a changed text asks again. A project is never trusted unasked, the same as for a plugin.
 */
export class SkillTrust {
  constructor(private readonly file: string) {}
  #read(): { allowed: string[]; denied: string[] } {
    try { const raw = JSON.parse(readFileSync(this.file, "utf8")) as { allowed?: unknown; denied?: unknown }; const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []); return { allowed: list(raw.allowed), denied: list(raw.denied) }; } catch { return { allowed: [], denied: [] }; }
  }
  readonly key = (s: Pick<SkillInfo, "name" | "hash">): string => `${s.name}:${s.hash}`;
  /** Whether the person said yes to exactly this. */
  said = (s: Pick<SkillInfo, "name" | "hash">): boolean => this.#read().allowed.includes(this.key(s));
  refused = (s: Pick<SkillInfo, "name" | "hash">): boolean => this.#read().denied.includes(this.key(s));
  /** Skills waiting for an answer: not accepted and not refused. */
  waiting(skills: readonly SkillInfo[]): SkillInfo[] { const { denied } = this.#read(); return skills.filter((s) => s.source === "project" && !this.said(s) && !denied.includes(this.key(s))); }
  /** Why a project skill is not in use: the person refused it, its text changed after they accepted it, or nobody has answered yet. */
  why(s: Pick<SkillInfo, "name" | "hash">): "refused" | "changed" | "waiting" { const now = this.#read(); return now.denied.includes(this.key(s)) ? "refused" : now.allowed.some((k) => k.startsWith(`${s.name}:`)) ? "changed" : "waiting"; }
  answer(s: Pick<SkillInfo, "name" | "hash">, allow: boolean): void {
    const now = this.#read(), k = this.key(s);
    const next = { allowed: now.allowed.filter((x) => x !== k), denied: now.denied.filter((x) => x !== k) };
    (allow ? next.allowed : next.denied).push(k);
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: 1, allowed: next.allowed.slice(-500), denied: next.denied.slice(-500) }));
      renameSync(tmp, this.file);
    } catch { /* a full disk must not stop the work */ }
  }
}

/** The skills in effect, less the ones switched off (and the project skills not yet accepted). */
export const activeSkills = (state: PluginState, dirs: Parameters<typeof loadSkills>[0], trust: SkillTrust): SkillInfo[] => { const off = state.disabled(); return loadSkills({ ...dirs, trusted: trust.said }).filter((s) => !off.has(skillId(s.name))); };

const HELD_WHY = { refused: "you refused it", changed: "its text changed after you accepted it", waiting: "not accepted yet" } as const;

/** The project skills that were held back and why, as aligned rows; nothing when none was. */
export function heldSkillsNote(skills: readonly SkillInfo[], trust: SkillTrust): string | undefined {
  const held = skills.filter((s) => !s.trusted);
  if (!held.length) return undefined;
  const width = Math.max(...held.map((s) => s.name.length));
  return `Skills of this project held back, not used:\n${held.map((s) => `  ${s.name.padEnd(width)}  ${HELD_WHY[trust.why(s)]}`).join("\n")}`;
}

/** Hooks less the ones switched off, keeping the others in their order. */
export function activeHooks(state: PluginState, hooks: HookConfig | undefined): HookConfig | undefined {
  if (!hooks) return undefined;
  const off = state.disabled();
  const out: HookConfig = {};
  for (const [event, list] of Object.entries(hooks)) {
    const kept = (list ?? []).filter((_, i) => !off.has(hookId(event, i)));
    if (kept.length) (out as Record<string, unknown>)[event] = kept;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Everything that extends the agent on this computer: skills, outside tool servers and hooks, with whether each is on. */
export function listPlugins(state: PluginState, file: ConfigFile | null, userSkills: string, cwd: string, packs?: { packs: readonly Pack[]; trust: SkillTrust; lock: PluginLock }): PluginInfo[] {
  const off = state.disabled();
  const out: PluginInfo[] = (packs?.packs ?? []).map((p) => packInfo(p, state, packs!.trust, packs!.lock, cwd));
  for (const s of loadSkills({ user: userSkills, project: projectSkillDirs(cwd) })) {
    out.push({ id: skillId(s.name), kind: "skill", name: s.name, description: s.description, enabled: !off.has(skillId(s.name)), source: s.source });
  }
  for (const [name, e] of Object.entries(file?.mcp ?? {})) {
    out.push({ id: mcpId(name), kind: "mcp", name, description: e.url ? `A tool server on the web (${new URL(e.url).hostname}).` : `A tool server that runs here: ${[e.command, ...(e.args ?? [])].filter(Boolean).join(" ").slice(0, 100)}.`, enabled: !off.has(mcpId(name)), source: "config", fromNext: true });
  }
  for (const [event, list] of Object.entries(file?.hooks ?? {})) {
    (list ?? []).forEach((h, i) => out.push({ id: hookId(event, i), kind: "hook", name: `${event}${h.matcher ? ` (${h.matcher})` : ""}`, description: `Runs: ${h.command.slice(0, 100)}`, enabled: !off.has(hookId(event, i)), source: "config", fromNext: true }));
  }
  return out;
}

/** A plugin is trusted under this name in the trust file, which holds skills by their own names: a skill cannot be named like this. */
export const packTrustKey = (p: Pick<Pack, "name" | "hash">): { name: string; hash: string } => ({ name: `plugin:${p.name}`, hash: p.hash });

/** Project plugins waiting for the person's answer. */
export const packsWaiting = (packs: readonly Pack[], trust: SkillTrust): Pack[] => packs.filter((p) => p.source === "project" && !p.problem && !trust.said(packTrustKey(p)) && !trust.refused(packTrustKey(p)));

/** The plugins that are in use: switched on by the person, whole, and (a project's) accepted. Everything installable is off until switched on. */
export function activePacks(state: PluginState, trust: SkillTrust, packs: readonly Pack[]): Pack[] {
  const on = state.enabledExplicitly();
  return packs.filter((p) => !p.problem && on.has(pluginId(p.name)) && (p.source === "user" || trust.said(packTrustKey(p))));
}

const PLUGIN_DIRS = (cwd: string): string[] => packDirs(projectDirs(cwd));

/** Every plugin on this computer and in this project, as read now. */
export const readPacks = (configDir: string, lock: PluginLock, cwd: string): Pack[] => loadPacks({ user: join(configDir, "plugins"), lock, project: PLUGIN_DIRS(cwd) });

/** Where the person's installed plugins and their lock file are, next to the configuration file. */
export const pluginPlaces = (configFile: string): { root: string; lock: PluginLock } => ({ root: join(dirname(configFile), "plugins"), lock: new PluginLock(join(dirname(configFile), "plugins.lock.json")) });

/** A plugin as the list shows it. */
export function packInfo(p: Pack, state: PluginState, trust: SkillTrust, lock: PluginLock, cwd: string): PluginInfo {
  const origin = p.source === "user" ? lock.read()[p.name]?.source : p.dir.startsWith(cwd) ? p.dir.slice(cwd.length).replace(/^[\\/]/, "") : p.dir;
  return {
    id: pluginId(p.name), kind: "plugin", name: p.name, description: p.description, enabled: !p.problem && state.enabledExplicitly().has(pluginId(p.name)), source: p.source, fromNext: true,
    version: p.version, ...(origin ? { origin } : {}), hash: p.hash,
    brings: { skills: p.skills, agents: p.agents, commands: p.commands, hooks: Object.values(p.hooks).reduce((n, l) => n + (l?.length ?? 0), 0), mcp: Object.keys(p.mcp) },
    runs: p.runs, ...(p.findings.length ? { findings: p.findings } : {}), trusted: p.source === "user" || trust.said(packTrustKey(p)), ...(p.problem ? { problem: p.problem } : {}),
  };
}

/** Hooks of the configuration and of the plugins in use, in that order. */
export function withPackHooks(hooks: HookConfig | undefined, packs: readonly Pack[]): HookConfig | undefined {
  const out: HookConfig = {};
  for (const source of [hooks ?? {}, ...packs.map((p) => p.hooks)]) for (const [event, list] of Object.entries(source)) (out as Record<string, unknown[]>)[event] = [...((out as Record<string, unknown[]>)[event] ?? []), ...(list ?? [])];
  return Object.keys(out).length ? out : undefined;
}

/** Tool servers of the plugins in use, each named after its plugin so two plugins cannot clash. */
export const packServers = (packs: readonly Pack[]): Record<string, McpServerConfig> => Object.fromEntries(packs.flatMap((p) => Object.entries(p.mcp).map(([n, e]) => [`${p.name}-${n}`, e] as const)));

/** The custom slash commands of the plugins in use. */
export const customCommands = (state: PluginState, trust: SkillTrust, configFile: string, cwd: string): PackCommand[] => {
  const places = pluginPlaces(configFile);
  return packCommands(activePacks(state, trust, readPacks(dirname(configFile), places.lock, cwd)));
};
