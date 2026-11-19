/**
 * Skills: written instructions for one kind of task, kept as a folder with a `SKILL.md`. Only the name and a one-line
 * description are always in front of the model; the whole text is read when the task calls for it (the Skill tool).
 * The format is the common one: a `---` block with `name` and `description`, then the instructions.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface SkillInfo {
  name: string;
  description: string;
  dir: string;
  source: "user" | "project";
}

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_BODY = 30_000;

/** The `key: value` lines between the first two `---` lines, and the rest. Quotes around a value are removed. */
export function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]!.toLowerCase()] = kv[2]!.trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return { meta, body: match[2]! };
}

function fromDir(root: string, source: SkillInfo["source"]): SkillInfo[] {
  if (!existsSync(root)) return [];
  const found: SkillInfo[] = [];
  let names: string[];
  try { names = readdirSync(root); } catch { return []; }
  for (const folder of names.sort()) {
    const dir = join(root, folder), file = join(dir, "SKILL.md");
    try {
      if (!statSync(dir).isDirectory() || !statSync(file).isFile()) continue;
      const { meta } = parseFrontmatter(readFileSync(file, "utf8"));
      const name = meta.name || folder;
      if (!NAME.test(name)) continue;
      found.push({ name, description: (meta.description ?? "").slice(0, 300), dir, source });
    } catch { /* a folder that cannot be read is not a skill */ }
  }
  return found;
}

/** The skills in effect: the person's own, then the project's. A project skill with the same name replaces the person's. */
export function loadSkills(dirs: { user?: string; project?: string[] }): SkillInfo[] {
  const byName = new Map<string, SkillInfo>();
  if (dirs.user) for (const s of fromDir(dirs.user, "user")) byName.set(s.name, s);
  for (const root of dirs.project ?? []) for (const s of fromDir(root, "project")) byName.set(s.name, s);
  return [...byName.values()];
}

/** What to read: the instructions, and the names of any other files in the folder, which can be read with Read. */
export function readSkill(skill: SkillInfo): string {
  const body = parseFrontmatter(readFileSync(join(skill.dir, "SKILL.md"), "utf8")).body.trim();
  const others = readdirSync(skill.dir).filter((f) => f !== "SKILL.md").slice(0, 30);
  const text = body.length > MAX_BODY ? `${body.slice(0, MAX_BODY)}\n… [shortened]` : body;
  return `# Skill: ${skill.name}\n\n${text}${others.length ? `\n\nFiles next to this skill, in ${skill.dir}: ${others.join(", ")}` : ""}`;
}

/** The list put in front of the model. Short, because a small model is easily led astray by long lists. */
export function skillsPrompt(skills: readonly SkillInfo[], small: boolean): string | undefined {
  if (!skills.length) return undefined;
  const shown = skills.slice(0, small ? 6 : 40);
  const lines = shown.map((s) => `- ${s.name}${s.description ? `: ${small ? s.description.slice(0, 100) : s.description}` : ""}`);
  return `Skills you can load with the Skill tool when a task matches one:\n${lines.join("\n")}${skills.length > shown.length ? `\n(and ${skills.length - shown.length} more)` : ""}`;
}
