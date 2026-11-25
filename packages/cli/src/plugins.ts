import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadSkills, projectDirs, type HookConfig, type SkillInfo } from "@navvied/engine";
import type { ConfigFile } from "./config.ts";
import { SKILL_FOLDERS } from "./presets.ts";

/** One thing that extends the agent, as a list shows it. Adding or removing one is done on the computer (files, configuration), never from a page. */
export interface PluginInfo {
  id: string;
  kind: "skill" | "mcp" | "hook";
  name: string;
  description: string;
  enabled: boolean;
  source: "user" | "project" | "config";
  /** Turning it on or off reaches the next new conversation, not the one open now. */
  fromNext?: true;
}

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

/** Every folder a project's skills may be in, from the outermost folder in, so an inner skill replaces an outer one of the same name. */
export const projectSkillDirs = (cwd: string): string[] => projectDirs(cwd).flatMap((d) => SKILL_FOLDERS.map((f) => join(d, ...f.split("/"))));

/**
 * Which skills that come with a project the person has accepted. A skill is accepted as it is: the fingerprint of its text is
 * what is kept, so a changed text asks again. With `confirm` off every project skill counts as accepted (and nothing is asked).
 */
export class SkillTrust {
  constructor(private readonly file: string, readonly confirm: boolean) {}
  #read(): { allowed: string[]; denied: string[] } {
    try { const raw = JSON.parse(readFileSync(this.file, "utf8")) as { allowed?: unknown; denied?: unknown }; const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []); return { allowed: list(raw.allowed), denied: list(raw.denied) }; } catch { return { allowed: [], denied: [] }; }
  }
  readonly key = (s: Pick<SkillInfo, "name" | "hash">): string => `${s.name}:${s.hash}`;
  accepted = (s: SkillInfo): boolean => !this.confirm || this.#read().allowed.includes(this.key(s));
  /** Skills waiting for an answer: not accepted and not refused. */
  waiting(skills: readonly SkillInfo[]): SkillInfo[] { const { denied } = this.#read(); return skills.filter((s) => s.source === "project" && !this.accepted(s) && !denied.includes(this.key(s))); }
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

/** The skills in effect, less the ones switched off (and, when the person asked to be asked, the project skills not yet accepted). */
export const activeSkills = (state: PluginState, dirs: Parameters<typeof loadSkills>[0], trust?: SkillTrust): SkillInfo[] => { const off = state.disabled(); return loadSkills({ ...dirs, ...(trust ? { trusted: trust.accepted } : {}) }).filter((s) => !off.has(skillId(s.name))); };

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
export function listPlugins(state: PluginState, file: ConfigFile | null, userSkills: string, cwd: string): PluginInfo[] {
  const off = state.disabled();
  const out: PluginInfo[] = [];
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
