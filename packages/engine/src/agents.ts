import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * A helper the person defined: a Markdown file whose top lines say what it is (`description`, and `tools` to name the tools it may
 * use), and whose text is how it works. The agent decides which helper to hand a task to from the description alone.
 */
export interface AgentDef {
  name: string;
  description: string;
  /** The tools it may use; without this it may use the ones that only read. */
  tools?: string[];
  /** `worktree`: when it may change files it works in a copy of the project (a git worktree), so its changes stay apart from this one. */
  isolation?: "worktree";
  /** How it works: its instructions. */
  prompt: string;
}

const NAME = /^[a-z][a-z0-9_-]{0,39}$/;

/** Reads one definition. A file without a description, or with a name that is not simple, is not a helper. */
export function parseAgent(text: string, fileName: string): AgentDef | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text.replace(/^﻿/, ""));
  if (!match) return undefined;
  const fields: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const at = line.indexOf(":");
    if (at > 0) fields[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim().replace(/^["']|["']$/g, "");
  }
  const name = (fields.name || fileName.replace(/\.md$/i, "")).toLowerCase();
  const description = fields.description?.slice(0, 300);
  const prompt = match[2]!.trim().slice(0, 12_000);
  if (!NAME.test(name) || !description || !prompt) return undefined;
  const tools = fields.tools ? fields.tools.replace(/^\[|\]$/g, "").split(",").map((t) => t.trim()).filter(Boolean) : undefined;
  return { name, description, ...(tools?.length ? { tools } : {}), ...(fields.isolation?.toLowerCase() === "worktree" ? { isolation: "worktree" as const } : {}), prompt };
}

/**
 * The folders helpers are read from, the weakest first (a later one wins over an earlier one with the same name): the person's own
 * `.claude/agents` and navvied's, then, from the git root down to the folder, each project folder's `.claude/agents` and `.navvied/agents`.
 */
export const agentDirs = (home: string, config: string, projects: readonly string[]): string[] => [join(home, ".claude", "agents"), join(config, "agents"), ...projects.flatMap((d) => [join(d, ".claude", "agents"), join(d, ".navvied", "agents")])];

/** The helpers in these folders. A later folder wins over an earlier one with the same name (the project over the person's own). */
export function loadAgents(dirs: readonly string[]): AgentDef[] {
  const found = new Map<string, AgentDef>();
  for (const dir of dirs) {
    let names: string[];
    try { names = readdirSync(dir).filter((n) => n.toLowerCase().endsWith(".md")).sort(); } catch { continue; }
    for (const n of names.slice(0, 50)) {
      try { const def = parseAgent(readFileSync(join(dir, n), "utf8"), n); if (def) found.set(def.name, def); } catch { /* unreadable: left out */ }
    }
  }
  return [...found.values()];
}
