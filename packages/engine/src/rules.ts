import nativePath from "node:path";

/** The path rules of the computer the files are on; tests pass the other system's. */
export type Paths = Pick<typeof nativePath, "isAbsolute" | "relative" | "resolve">;

/**
 * Permission rules the person writes in their own configuration: what the agent may always do, must always ask about, and may never do.
 * A rule is a tool name, or a tool name with a pattern in brackets:
 *   "Bash(npm run *)"     a command (every part of a command joined with && ; | must be covered to allow it)
 *   "Edit(src/**)"        a file, relative to the project (`*` stays in one folder, `**` goes deeper)
 *   "WebFetch(domain:example.com)"   a website and its subdomains
 *   "Bash"                every use of the tool
 * Deny beats ask, and ask beats allow. A rule never lifts the hard limits below.
 */
export interface RuleSet { allow: string[]; ask: string[]; deny: string[] }

export type Verdict = { kind: "none" } | { kind: "allow" | "ask" | "deny"; rule: string };

const MOST = 200;
const SHAPE = /^([A-Za-z][A-Za-z0-9_]*)(?:\((.*)\))?$/s;

/** Reads the rules from configuration, leaving out anything that is not a rule written the right way. */
export function parseRules(raw: unknown): RuleSet {
  const out: RuleSet = { allow: [], ask: [], deny: [] };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  for (const key of ["allow", "ask", "deny"] as const) {
    const list = (raw as Record<string, unknown>)[key];
    if (Array.isArray(list)) out[key] = list.filter((r): r is string => typeof r === "string" && SHAPE.test(r.trim())).map((r) => r.trim()).slice(0, MOST);
  }
  return out;
}

export const hasRules = (r: RuleSet): boolean => r.allow.length + r.ask.length + r.deny.length > 0;

const escape = (s: string): string => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");

/** A pattern as a test. In a command `*` is anything; in a path `*` is anything but a slash and `**` anything. A trailing ` *` also matches the bare command. */
function matcher(pattern: string, path: boolean): RegExp {
  let source = "";
  const bare = !path && pattern.endsWith(" *");
  const body = bare ? pattern.slice(0, -2) : pattern;
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c === "*") {
      if (path && body[i + 1] === "*") { source += ".*"; i++; if (body[i + 1] === "/") i++; } else source += path ? "[^/]*" : ".*";
    } else source += escape(c);
  }
  return new RegExp(`^${source}${bare ? "( .*)?" : ""}$`, "s");
}

/** The parts of a command that run separately. Substitutions are not taken apart: see `opaque`. */
export function splitCommand(command: string): string[] {
  return command.split(/&&|\|\||;|\||\r?\n|(?<![>&])&(?![&>])/).map((p) => p.trim()).filter(Boolean);
}

/** A command that runs something the rule cannot see (a command inside another), so it is never allowed by a rule. */
const opaque = (command: string): boolean => /\$\(|`|<\(|>\(/.test(command);

/** A path as rules see it: relative to the project when inside it, else whole. On Windows a path without a drive is on the project's. */
function pathOf(file: unknown, cwd: string, p: Paths): string | undefined {
  if (typeof file !== "string" || !file) return undefined;
  const full = p.resolve(cwd, file);
  const inside = p.relative(p.resolve(cwd), full).replace(/\\/g, "/");
  return inside.startsWith("..") || p.isAbsolute(inside) ? full.replace(/\\/g, "/") : inside;
}

function hostOf(url: unknown): string | undefined {
  try { return typeof url === "string" ? new URL(url).hostname.toLowerCase() : undefined; } catch { return undefined; }
}

/** Does the rule's pattern cover this one thing (a command part, a path, a host)? */
function covers(tool: string, pattern: string | undefined, subject: string, cwd: string, p: Paths): boolean {
  if (pattern === undefined || pattern === "" || pattern === "*") return true;
  if (tool === "WebFetch" || tool === "Browser") {
    const domain = /^domain:(.+)$/i.exec(pattern)?.[1]?.toLowerCase();
    return domain !== undefined && (subject === domain || subject.endsWith(`.${domain}`));
  }
  if (tool === "Bash") return matcher(pattern, false).test(subject);
  // An outside path is whole and, on Windows, starts with a drive: the pattern is made whole the same way.
  return matcher(p.isAbsolute(pattern) ? p.resolve(cwd, pattern).replace(/\\/g, "/") : pattern, true).test(subject);
}

export class Rules {
  readonly #parsed: { allow: Parsed[]; ask: Parsed[]; deny: Parsed[] };
  constructor(set: RuleSet, private readonly cwd: string, private readonly paths: Paths = nativePath) {
    const parse = (list: string[]): Parsed[] => list.flatMap((text) => { const m = SHAPE.exec(text); return m ? [{ text, tool: m[1]!, pattern: m[2] }] : []; });
    this.#parsed = { allow: parse(set.allow), ask: parse(set.ask), deny: parse(set.deny) };
  }

  /** What the rules say about one use of a tool. */
  check(tool: string, args: Record<string, unknown>): Verdict {
    const subjects = this.#subjects(tool, args);
    for (const kind of ["deny", "ask"] as const) {
      for (const r of this.#parsed[kind]) if (r.tool === tool && subjects.some((s) => covers(tool, r.pattern, s, this.cwd, this.paths))) return { kind, rule: r.text };
    }
    // To allow, every part must be covered, and a command that hides one inside another is never allowed by a rule.
    if (tool === "Bash" && opaque(String(args.command ?? ""))) return { kind: "none" };
    if (subjects.length === 0) return { kind: "none" };
    const mine = this.#parsed.allow.filter((r) => r.tool === tool);
    const whole = mine.find((r) => subjects.every((s) => covers(tool, r.pattern, s, this.cwd, this.paths)));
    if (whole) return { kind: "allow", rule: whole.text };
    const parts = subjects.map((s) => mine.find((r) => covers(tool, r.pattern, s, this.cwd, this.paths)));
    return parts.every(Boolean) ? { kind: "allow", rule: parts[0]!.text } : { kind: "none" };
  }

  #subjects(tool: string, args: Record<string, unknown>): string[] {
    if (tool === "Bash") return splitCommand(String(args.command ?? ""));
    if (tool === "WebFetch" || tool === "Browser") { const h = hostOf(args.url); return h ? [h] : tool === "Browser" ? [""] : []; }
    const file = pathOf(args.file_path ?? args.path, this.cwd, this.paths);
    return file ? [file] : tool === "Write" || tool === "Edit" || tool === "Read" ? [] : [""];
  }
}

interface Parsed { text: string; tool: string; pattern: string | undefined }

/** The files that hold what the agent may do: it can never change its own permissions, whatever the mode. */
const OWN_PERMISSIONS = /(^|\/)(\.navvied\/permissions\.json|navvied\/config\.json)$/;
const SYSTEM_DIRS = /^\/(etc|boot|usr|bin|sbin|lib|lib64|System|dev|proc|sys)(\/|$)/;
const WINDOWS_SYSTEM_DIRS = /^[a-z]:\/(windows|program files|program files \(x86\)|programdata)(\/|$)/i;

/** What `rm -r` must never be pointed at: the disk, the home folder, or a whole system folder. */
const WHOLE = /^(\/|~|\$HOME|\/\*|~\/\*|\$HOME\/\*|\/(etc|boot|usr|bin|sbin|lib|lib64|var|opt|root|home|System|Library|Applications|dev|proc|sys)\/?\*?)$/;

/** The reason a shell command may never run, or nothing. A command inside `sh -c '…'` is looked at too, and quotes do not hide a path. */
function blockedCommand(command: string, depth = 0): string | undefined {
  for (const part of splitCommand(command)) {
    const plain = part.replace(/^(sudo|doas|env)\s+/, "").trim();
    const inner = /^(?:ba|z|da|k)?sh\s+-[a-z]*c\s+(["'])([\s\S]*)\1\s*$/.exec(plain)?.[2];
    if (inner !== undefined && depth < 3) { const why = blockedCommand(inner, depth + 1); if (why) return why; }
    const words = plain.replace(/["']/g, "");
    if (/^rm\s/.test(words)) {
      const args = words.split(/\s+/).slice(1);
      const recursive = args.some((a) => /^-[a-zA-Z]*[rR]/.test(a) || a === "--recursive");
      if (recursive && args.some((a) => !a.startsWith("-") && WHOLE.test(a))) return "this would delete the whole home folder, a system folder or the whole disk";
    }
    if (/^mkfs(\.|\s|$)/.test(words)) return "this would format a disk";
    if (/^dd\s.*\bof=\/dev\/(sd|nvme|hd|vd|disk|mmcblk)/.test(words)) return "this would overwrite a disk";
    if (/^(shutdown|reboot|halt|poweroff)(\s|$)/.test(words)) return "this would switch the computer off";
    if (/^chmod\s+(-[a-zA-Z]*R[a-zA-Z]*\s+)\S+\s+\/(\s|$)/.test(words) || /^chown\s+(-[a-zA-Z]*R[a-zA-Z]*\s+)\S+\s+\/(\s|$)/.test(words)) return "this would change the rights of every file on the computer";
    if (/>\s*\/dev\/(sd|nvme|hd|vd|disk|mmcblk)/.test(words)) return "this would overwrite a disk";
    if (/^kill\s+(?:-\S+\s+)*-1(\s|$)/.test(words)) return "this would stop every program you have running";
  }
  if (/:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/.test(command)) return "this is a fork bomb";
  return undefined;
}

/**
 * What the agent may never do, whatever the mode and whatever the rules say: wipe the computer, format a disk, write over the
 * system. Short on purpose: it stops the disasters, and everything else is left to the mode and to the person's rules.
 * Returns the reason, or nothing when the call is not one of these.
 */
export function hardBlock(tool: string, args: Record<string, unknown>, cwd: string, p: Paths = nativePath): string | undefined {
  if (tool === "Bash") return blockedCommand(String(args.command ?? ""));
  if (tool === "Write" || tool === "Edit") {
    const file = args.file_path;
    if (typeof file === "string") {
      const full = p.resolve(cwd, file).replace(/\\/g, "/");
      if (SYSTEM_DIRS.test(full) || WINDOWS_SYSTEM_DIRS.test(full)) return "this would change a system folder";
      if (OWN_PERMISSIONS.test(full)) return "this would change what the agent is allowed to do";
    }
  }
  return undefined;
}
