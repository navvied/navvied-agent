/**
 * Skills: written instructions for one kind of task, kept as a folder with a `SKILL.md`. Only the name and a short
 * description are always in front of the model; the whole text is read when the task calls for it (the Skill tool).
 * The format is the common one: a `---` front matter block (name, description, and the optional fields below), then the instructions.
 * `disable-model-invocation: true` keeps a skill out of the model's list; `allowed-tools` is read and ignored on purpose: it only
 * pre-approves tools there, and the permission model here does not hand out approvals from a text file.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { scanText } from "./text-scan.ts";
import { parseYaml, type YamlValue } from "./yaml-lite.ts";

export interface SkillInfo {
  name: string;
  description: string;
  dir: string;
  source: "user" | "project";
  /** False when the front matter says `disable-model-invocation: true`: only the person may use it. */
  modelInvocable: boolean;
  /** False when the front matter says `user-invocable: false`. */
  userInvocable: boolean;
  /** Whether the person has accepted this skill's text (the person's own skills always are). */
  trusted: boolean;
  /** Fingerprint of SKILL.md, so a trust given once does not carry over to changed text. */
  hash: string;
  /** What the scan found in its text, in words. */
  findings: string[];
}

export const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_BODY = 30_000;
const DESCRIPTION = 300;

export const skillHash = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 16);

/** The front matter (see `parseYaml`) and the rest. */
export function parseFrontmatter(text: string): { meta: Record<string, YamlValue>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  return match ? { meta: parseYaml(match[1]!), body: match[2]! } : { meta: {}, body: text };
}

const asText = (v: YamlValue | undefined): string => (Array.isArray(v) ? v.join(", ") : typeof v === "string" ? v : "");

function fromDir(root: string, source: SkillInfo["source"], trusted: (s: SkillInfo) => boolean): SkillInfo[] {
  if (!existsSync(root)) return [];
  const found: SkillInfo[] = [];
  let names: string[];
  try { names = readdirSync(root); } catch { return []; }
  for (const folder of names.sort()) {
    const dir = join(root, folder), file = join(dir, "SKILL.md");
    try {
      if (!statSync(dir).isDirectory() || !statSync(file).isFile()) continue;
      const text = readFileSync(file, "utf8");
      const { meta, body } = parseFrontmatter(text);
      const name = asText(meta.name) || folder;
      if (!NAME.test(name)) continue;
      const first = body.split(/\r?\n/).find((l) => l.trim())?.replace(/^#+\s*/, "") ?? "";
      const description = [asText(meta.description) || first, asText(meta.when_to_use)].filter(Boolean).join(" ").replace(/\s+/g, " ").slice(0, DESCRIPTION);
      const info: SkillInfo = { name, description, dir, source, modelInvocable: meta["disable-model-invocation"] !== true, userInvocable: meta["user-invocable"] !== false, trusted: true, hash: skillHash(text), findings: source === "project" ? scanText(text) : [] };
      found.push({ ...info, trusted: source === "user" || trusted(info) });
    } catch { /* a folder that cannot be read is not a skill */ }
  }
  return found;
}

/**
 * The skills in effect: the person's own, then the project's. `project` lists folders from the lowest priority to the highest
 * (an outer folder before an inner one, and within a folder the shared layouts before navvied's own), and a later skill with the
 * same name replaces an earlier one. `trusted` says whether the person has accepted a project skill (all are when it is not given).
 */
export function loadSkills(dirs: { user?: string; project?: string[]; /** Folders of plugins the person switched on and accepted: the skills in them count as the person's own, below the person's own folder. */ plugins?: string[]; trusted?: (s: SkillInfo) => boolean }): SkillInfo[] {
  const byName = new Map<string, SkillInfo>();
  const trusted = dirs.trusted ?? (() => true);
  for (const root of dirs.plugins ?? []) for (const s of fromDir(root, "user", trusted)) byName.set(s.name, s);
  if (dirs.user) for (const s of fromDir(dirs.user, "user", trusted)) byName.set(s.name, s);
  for (const root of dirs.project ?? []) for (const s of fromDir(root, "project", trusted)) byName.set(s.name, s);
  return [...byName.values()];
}

/** What to read: the instructions, and the names of any other files in the folder, which can be read with Read. */
export function readSkill(skill: SkillInfo): string {
  const body = parseFrontmatter(readFileSync(join(skill.dir, "SKILL.md"), "utf8")).body.trim();
  const others = readdirSync(skill.dir).filter((f) => f !== "SKILL.md").slice(0, 30);
  const text = body.length > MAX_BODY ? `${body.slice(0, MAX_BODY)}\n… [shortened]` : body;
  return `# Skill: ${skill.name}\n\n${text}${others.length ? `\n\nFiles next to this skill, in ${skill.dir}: ${others.join(", ")}` : ""}`;
}

/** The skills the model may load: not switched off for it, and accepted by the person. */
export const modelSkills = (skills: readonly SkillInfo[]): SkillInfo[] => skills.filter((s) => s.modelInvocable && s.trusted);

/** The list put in front of the model, within a budget of characters (so many skills cannot crowd out the task). Small models get less. */
export function skillsPrompt(skills: readonly SkillInfo[], small: boolean): string | undefined {
  if (!skills.length) return undefined;
  const budget = small ? 700 : 3_000, cut = small ? 90 : 160;
  const lines: string[] = [];
  let used = 0;
  for (const s of skills) {
    const line = `- ${s.name}${s.description ? `: ${s.description.length > cut ? `${s.description.slice(0, cut - 1)}…` : s.description}` : ""}`;
    if (used + line.length > budget && lines.length) break;
    lines.push(line);
    used += line.length + 1;
  }
  return `Skills you can load with the Skill tool when a task matches one:\n${lines.join("\n")}${skills.length > lines.length ? `\n(and ${skills.length - lines.length} more: name one to load it)` : ""}`;
}
