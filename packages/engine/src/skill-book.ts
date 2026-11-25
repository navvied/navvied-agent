/**
 * How the agent makes and changes skills, and how every change is kept. Each change is one line in an append-only ledger with the
 * text of the skill before and after, so any change can be undone (`rollback`) and a change that waits for the person (`ask`)
 * is applied only when accepted. Nothing is kept outside the skill's own folder, and what the agent writes is scanned first.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, sep } from "node:path";
import { NAME, parseFrontmatter, type SkillInfo } from "./skills.ts";
import { clean, scanText } from "./text-scan.ts";

export const SKILL_LIMIT = 100_000;
const FILES_MOST = 40;
const SKIP = new Set([".git", "node_modules", "__pycache__"]);

/** The text files of a skill folder, by path inside it. */
type Manifest = Record<string, string>;

export interface Change {
  id: string;
  at: number;
  name: string;
  action: "create" | "patch" | "delete";
  actor: "agent" | "person";
  dir: string;
  before: Manifest;
  after: Manifest;
  /** False while it waits for the person. */
  applied: boolean;
  /** What became of it: accepted or rejected (when it waited), or rolled back. */
  outcome?: "accepted" | "rejected" | "rolled-back";
}

export interface SkillRoots {
  /** Where the person's own skills are kept (for every project), when there is such a place. */
  user?: string;
  /** Where this project's skills are kept. */
  project?: string;
  ledger: string;
}

export type Edit = { action: "create"; name: string; scope: "project" | "user"; text: string; file?: string } | { action: "patch"; name: string; old: string; replace: string; file?: string } | { action: "delete"; name: string };

function readManifest(dir: string): Manifest {
  const out: Manifest = {};
  const walk = (at: string, depth: number): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue;
      const full = join(at, entry.name);
      if (entry.isDirectory() && depth < 3) walk(full, depth + 1);
      else if (entry.isFile() && statSync(full).size <= SKILL_LIMIT) {
        const text = readFileSync(full, "utf8");
        if (!text.includes("\0") && Object.keys(out).length < FILES_MOST) out[normalize(full.slice(dir.length + 1)).split(sep).join("/")] = text;
      }
    }
  };
  if (existsSync(dir)) walk(dir, 0);
  return out;
}

function writeManifest(dir: string, files: Manifest): void {
  rmSync(dir, { recursive: true, force: true });
  if (!Object.keys(files).length) return;
  for (const [path, text] of Object.entries(files)) {
    const target = join(dir, path), tmp = `${target}.${process.pid}.tmp`;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(tmp, text);
    renameSync(tmp, target);
  }
}

const same = (a: Manifest, b: Manifest): boolean => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

/** A path inside a skill folder: relative, no way out of it. */
const inside = (file: string): string | undefined => {
  const p = normalize(file).split(sep).join("/");
  return !p || p.startsWith("..") || p.startsWith("/") || /^[A-Za-z]:/.test(p) || p.split("/").includes("..") ? undefined : p;
};

export class SkillBook {
  constructor(private readonly roots: SkillRoots, private readonly now: () => number = Date.now) {}

  /** Every change in order, with what became of each. */
  changes(): Change[] {
    const byId = new Map<string, Change>();
    let lines: string[] = [];
    try { lines = readFileSync(this.roots.ledger, "utf8").split("\n"); } catch { /* no ledger yet */ }
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as Change | { resolve: string; outcome: Change["outcome"] };
        if ("resolve" in e) { const c = byId.get(e.resolve); if (c) { c.outcome = e.outcome; if (e.outcome === "accepted") c.applied = true; } } else byId.set(e.id, e);
      } catch { /* a damaged line is skipped, the rest still counts */ }
    }
    return [...byId.values()];
  }

  /** The changes waiting for the person. */
  staged(): Change[] { return this.changes().filter((c) => !c.applied && !c.outcome); }

  /** Makes or changes a skill. `stage` keeps the change for the person instead of applying it. Returns what to tell the model. */
  edit(e: Edit, actor: Change["actor"], stage: boolean, known: readonly SkillInfo[]): string {
    if (!NAME.test(e.name)) return `Error: a skill name is lowercase letters, digits and hyphens, for example "release-notes".`;
    const existing = known.find((s) => s.name === e.name);
    const root = e.action === "create" ? (e.scope === "user" ? this.roots.user : this.roots.project) : undefined;
    const dir = e.action === "create" ? root && join(root, e.name) : existing?.dir;
    if (!dir) return e.action === "create" ? `Error: there is no place for ${e.scope === "user" ? "skills for every project" : "this project's skills"} here.` : `Error: there is no skill "${e.name}". ${this.known(known)}`;
    const before = readManifest(dir);
    const after: Manifest = { ...before };
    if (e.action === "create") {
      if (existing || Object.keys(before).length) return `Error: the skill "${e.name}" exists. Change it with action patch, or pick another name.`;
      const target = e.file ? inside(e.file) : "SKILL.md";
      if (!target) return "Error: file must be a path inside the skill folder.";
      if (!e.file) { const fail = checkSkillText(e.text); if (fail) return fail; }
      after[target] = e.text;
    } else if (e.action === "patch") {
      const target = inside(e.file ?? "SKILL.md");
      const text = target ? before[target] : undefined;
      if (text === undefined) return `Error: there is no file "${e.file ?? "SKILL.md"}" in the skill "${e.name}". Files: ${Object.keys(before).join(", ")}.`;
      const at = text.indexOf(e.old);
      if (!e.old || at < 0) return `Error: the text to replace was not found in ${target}. Use action view to see the file, and copy the lines exactly.`;
      if (text.indexOf(e.old, at + 1) >= 0) return "Error: that text appears more than once. Include more of the lines around it.";
      after[target!] = text.slice(0, at) + e.replace + text.slice(at + e.old.length);
      if (target === "SKILL.md") { const fail = checkSkillText(after[target]!); if (fail) return fail; }
    } else for (const k of Object.keys(after)) delete after[k];
    if (JSON.stringify(after).length > SKILL_LIMIT * 2) return `Error: a skill is at most ${SKILL_LIMIT} characters of text. Split it into files next to SKILL.md.`;
    const hidden = Object.entries(after).filter(([k, v]) => before[k] !== v).flatMap(([k, v]) => scanText(v).map((f) => `${k}: ${f}`));
    if (hidden.length) return `Error: not saved, the text has ${hidden.join("; ")}. Take that out and try again.`;
    const change: Change = { id: this.id(), at: this.now(), name: e.name, action: e.action, actor, dir, before, after, applied: false };
    if (!stage) { writeManifest(dir, after); change.applied = true; }
    this.#append(change);
    const verb = { create: "Created", patch: "Changed", delete: "Deleted" }[e.action];
    return stage ? `Staged: ${e.action} skill "${e.name}" waits for the person to accept it (change ${change.id}). It is not in effect yet.` : `${verb} the skill "${e.name}" (change ${change.id}; the person can undo it).`;
  }

  /** Accepts or rejects a change that waits. */
  resolve(id: string, accept: boolean): string {
    const c = this.staged().find((x) => x.id === id);
    if (!c) return `Error: no change "${id}" is waiting.`;
    if (accept) {
      if (!same(readManifest(c.dir), c.before)) return `Error: the skill "${c.name}" was changed by hand since; reject this one and ask again.`;
      writeManifest(c.dir, c.after);
    }
    this.#append({ resolve: id, outcome: accept ? "accepted" : "rejected" });
    return accept ? `Applied change ${id} to "${c.name}".` : `Rejected change ${id}.`;
  }

  /** Undoes an applied change, unless the skill was changed again since (then it says so and leaves it). */
  rollback(id?: string): string {
    const done = this.changes().filter((c) => c.applied && c.outcome !== "rolled-back" && c.outcome !== "rejected");
    const c = id ? done.find((x) => x.id === id) : done.at(-1);
    if (!c) return id ? `Error: no applied change "${id}" to undo.` : "Error: there is no change to undo.";
    if (!same(readManifest(c.dir), c.after)) return `Error: the skill "${c.name}" was changed after ${c.id}; undo the later change first, or edit it by hand.`;
    writeManifest(c.dir, c.before);
    this.#append({ resolve: c.id, outcome: "rolled-back" });
    return `Undid change ${c.id}: the skill "${c.name}" is as it was.`;
  }

  /** The files of one skill, for the model to read. */
  view(skill: SkillInfo, file?: string): string {
    const files = readManifest(skill.dir);
    if (!file) return `# ${skill.name} (${skill.source}, ${skill.dir})\nFiles: ${Object.keys(files).join(", ")}\n\n${clean(files["SKILL.md"] ?? "")}`;
    const target = inside(file);
    return target && files[target] !== undefined ? clean(files[target]!) : `Error: no file "${file}" in "${skill.name}". Files: ${Object.keys(files).join(", ")}.`;
  }

  known(known: readonly SkillInfo[]): string { return known.length ? `Skills: ${known.map((s) => s.name).join(", ")}.` : "There are no skills yet."; }

  id(): string { return `${this.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`; }

  #append(line: Change | { resolve: string; outcome: Change["outcome"] }): void {
    mkdirSync(dirname(this.roots.ledger), { recursive: true });
    appendFileSync(this.roots.ledger, `${JSON.stringify(line)}\n`);
  }
}

/** A skill's text must have a front matter block that says what it is for, or it will never be chosen. */
function checkSkillText(text: string): string | undefined {
  const { meta } = parseFrontmatter(text);
  if (typeof meta.description !== "string" || !meta.description.trim()) return 'Error: SKILL.md must begin with a front matter block: "---", "name: …", "description: when to use it", "---", then the steps.';
  return undefined;
}
