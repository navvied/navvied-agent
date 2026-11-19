import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadSkills, projectDirs, type HookConfig, type SkillInfo } from "@navvied/engine";
import type { ConfigFile } from "./config.ts";

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
  disabled(): Set<string> {
    try { const raw = JSON.parse(readFileSync(this.file, "utf8")) as { disabled?: unknown }; return new Set(Array.isArray(raw.disabled) ? raw.disabled.filter((x): x is string => typeof x === "string") : []); } catch { return new Set(); }
  }
  set(id: string, enabled: boolean): void {
    const off = this.disabled();
    if (enabled) off.delete(id); else off.add(id);
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: 1, disabled: [...off].slice(-500) }));
      renameSync(tmp, this.file);
    } catch { /* a full disk must not stop the work */ }
  }
}

export const hookId = (event: string, index: number): string => `hook:${event}:${index}`;
export const skillId = (name: string): string => `skill:${name}`;
export const mcpId = (name: string): string => `mcp:${name}`;

/** The skills in effect, less the ones switched off. */
export const activeSkills = (state: PluginState, dirs: Parameters<typeof loadSkills>[0]): SkillInfo[] => { const off = state.disabled(); return loadSkills(dirs).filter((s) => !off.has(skillId(s.name))); };

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
  for (const s of loadSkills({ user: userSkills, project: projectDirs(cwd).map((d) => join(d, ".navvied", "skills")) })) {
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
