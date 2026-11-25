import nativePath, { posix } from "node:path";
import { shellView } from "./shell-scan.ts";
import { expandHome, homeFrom } from "./where.ts";
import { EDIT_LIKE, FILE_WRITERS, changedPaths } from "./tools/changed.ts";

/** The path rules of the computer the files are on; tests pass the other system's. */
export type Paths = Pick<typeof nativePath, "isAbsolute" | "relative" | "resolve" | "sep"> & { caseless?: boolean; /** What `~` is: the home folder of the environment the program was given. */ home?: string };

/**
 * The path rules of this computer. Written out, not `nativePath`: on a Unix computer `path.posix` is the same object as `path`, so a
 * test that passes `posix` to stand for Linux would be taken for the real thing on a Mac.
 */
export const nativePaths: Paths = { isAbsolute: nativePath.isAbsolute, relative: nativePath.relative, resolve: nativePath.resolve, sep: nativePath.sep, caseless: nativePath.sep === "\\" || process.platform === "darwin" };

/** Windows and macOS keep one file under every spelling of its name (`.ENV` is `.env`), so a rule written for one must hold for all. */
export const caselessFor = (p: Paths): boolean => p.caseless ?? p.sep === "\\";

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
function matcher(pattern: string, path: boolean, caseless = false): RegExp {
  let source = "";
  const bare = !path && pattern.endsWith(" *");
  const body = bare ? pattern.slice(0, -2) : pattern;
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c === "*") {
      if (path && body[i + 1] === "*") { source += ".*"; i++; if (body[i + 1] === "/") i++; } else source += path ? "[^/]*" : ".*";
    } else source += escape(c);
  }
  return new RegExp(`^${source}${bare ? "( .*)?" : ""}$`, caseless ? "si" : "s");
}

/** The parts of a command that run separately. Substitutions are not taken apart: see `opaque`. */
export function splitCommand(command: string): string[] {
  return command.split(/&&|\|\||;|\||\r?\n|(?<![>&])&(?![&>])/).map((p) => p.trim()).filter(Boolean);
}

/** A command that runs something the rule cannot see (a command inside another), so it is never allowed by a rule. */
export const opaque = (command: string): boolean => /\$\(|`|<\(|>\(/.test(command);

/** A path as rules see it: relative to the project when inside it, else whole. On Windows a path without a drive is on the project's. */
function pathOf(file: unknown, cwd: string, p: Paths): string | undefined {
  if (typeof file !== "string" || !file) return undefined;
  const full = p.resolve(cwd, expandHome(file, p.home ?? homeFrom()));
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
  return matcher(p.isAbsolute(pattern) ? p.resolve(cwd, pattern).replace(/\\/g, "/") : pattern, true, caselessFor(p)).test(subject);
}

/** The names a rule may use for a tool: its own, and `Edit` for the other tools that edit. */
const named = (tool: string): string[] => (EDIT_LIKE.has(tool) ? [tool, "Edit"] : [tool]);

export class Rules {
  readonly #parsed: { allow: Parsed[]; ask: Parsed[]; deny: Parsed[] };
  constructor(set: RuleSet, private readonly cwd: string, private readonly paths: Paths = nativePaths) {
    const parse = (list: string[]): Parsed[] => list.flatMap((text) => { const m = SHAPE.exec(text); return m ? [{ text, tool: m[1]!, pattern: m[2] }] : []; });
    this.#parsed = { allow: parse(set.allow), ask: parse(set.ask), deny: parse(set.deny) };
  }

  /** What the rules say about one use of a tool. */
  check(tool: string, args: Record<string, unknown>): Verdict {
    const subjects = this.#subjects(tool, args);
    for (const kind of ["deny", "ask"] as const) {
      for (const r of this.#parsed[kind]) if (named(tool).includes(r.tool) && subjects.some((s) => covers(tool, r.pattern, s, this.cwd, this.paths))) return { kind, rule: r.text };
    }
    // To allow, every part must be covered, and a command that hides one inside another is never allowed by a rule.
    if (tool === "Bash" && opaque(String(args.command ?? ""))) return { kind: "none" };
    if (subjects.length === 0) return { kind: "none" };
    const mine = this.#parsed.allow.filter((r) => named(tool).includes(r.tool));
    const whole = mine.find((r) => subjects.every((s) => covers(tool, r.pattern, s, this.cwd, this.paths)));
    if (whole) return { kind: "allow", rule: whole.text };
    const parts = subjects.map((s) => mine.find((r) => covers(tool, r.pattern, s, this.cwd, this.paths)));
    return parts.every(Boolean) ? { kind: "allow", rule: parts[0]!.text } : { kind: "none" };
  }

  #subjects(tool: string, args: Record<string, unknown>): string[] {
    if (tool === "Bash") return splitCommand(String(args.command ?? ""));
    if (tool === "WebFetch" || tool === "Browser") { const h = hostOf(args.url); return h ? [h] : tool === "Browser" ? [""] : []; }
    if (FILE_WRITERS.has(tool)) return changedPaths(tool, args).flatMap((f) => pathOf(f, this.cwd, this.paths) ?? []);
    const file = pathOf(args.file_path ?? args.path, this.cwd, this.paths);
    return file ? [file] : tool === "Read" ? [] : [""];
  }
}

interface Parsed { text: string; tool: string; pattern: string | undefined }

/** The files that hold what the agent may do: it can never change its own permissions, whatever the mode. */
const OWN_PERMISSIONS = /(^|\/)(\.navvied\/permissions\.json|navvied\/config\.json)$/;
const SYSTEM_DIRS = /^\/(etc|boot|usr|bin|sbin|lib|lib64|System|dev|proc|sys)(\/|$)/;
/** The same patterns for a computer that does not tell `ETC` from `etc`. */
const folded = (re: RegExp): RegExp => new RegExp(re.source, "i");
const OWN_PERMISSIONS_CASELESS = folded(OWN_PERMISSIONS), SYSTEM_DIRS_CASELESS = folded(SYSTEM_DIRS);
const WINDOWS_SYSTEM_DIRS = /^[a-z]:\/(windows|program files|program files \(x86\)|programdata)(\/|$)/i;

/** What `rm -r` must never be pointed at: the disk, the home folder, or a whole system folder. */
const WHOLE = /^(\/|~|\$HOME|\/\*|~\/\*|\$HOME\/\*|\/(etc|boot|usr|bin|sbin|lib|lib64|var|opt|root|home|System|Library|Applications|dev|proc|sys)\/?\*?)$/;

const SYSTEM_WHOLE = /^\/(etc|boot|usr|bin|sbin|lib|lib64|var|opt|root|home|Users|System|Library|Applications|dev|proc|sys)$/;

/**
 * Whether a target of a delete is the disk, a folder every program depends on, or a whole home folder, however it is spelt: `~`, `$HOME` and
 * `${HOME}` are put in for the home folder first, then the path is made plain the way the shell makes it (`//` is `/`, a last `/` or `/.` is nothing,
 * `..` goes up), then it is compared as a place, not as writing. A path that is not absolute here is the project's own, and is not this.
 */
function wholeFolder(target: string, homeDir: string): boolean {
  const home = posix.normalize(homeDir.replace(/\\/g, "/")).replace(/(.)\/+$/, "$1");
  let t = expandHome(target, home);
  if (!t.startsWith("/")) return false;
  t = posix.normalize(t).replace(/\/\*$/, "").replace(/(.)\/+$/, "$1") || "/";
  return t === "/" || t === home || home.startsWith(`${t}/`) || SYSTEM_WHOLE.test(t) || /^\/(home|Users)\/[^/]+$/.test(t);
}

/**
 * What a delete must never be pointed at on Windows, in any of its shells: a drive (`C:`, `/c` in Git Bash), the folders every
 * Windows install is made of, a user's whole home folder, or the variables that stand for them. Spelt with `/` or `\\`, in any case.
 */
const DRIVE = String.raw`(?:[a-z]:|/[a-z])`;
const SPELLED = String.raw`(?:%(?:userprofile|systemdrive|homedrive|homepath|windir|systemroot)%|\$env:(?:userprofile|systemdrive|homedrive|windir|systemroot)|\$\{?(?:userprofile|systemdrive)\}?)`;
const WINDOWS_WHOLE = new RegExp(String.raw`(?:^|\s)(?:${SPELLED}|${DRIVE}(?:/(?:windows|programdata|program files(?: \(x86\))?|users(?:/[^/\s]+)?))?)/?\*?(?=\s|$)`);

/** The reason one command, as the shell will run it, may never run. */
function blockedLine(line: string, home: string): string | undefined {
  const words = line.trim();
  if (/^(rm|ri|rmdir|rd|del|erase|remove-item)\s/i.test(words)) {
    const args = words.split(/\s+/).slice(1);
    const recursive = args.some((a) => /^-[a-zA-Z]*[rR]/.test(a) || a === "--recursive" || /^\/s$/i.test(a));
    // `/q` after rd, rmdir, del or erase is a switch, not the folder /q.
    const targets = /^(rm|ri|remove-item)\s/i.test(words) ? args : args.filter((a) => !/^\/[a-z]$/i.test(a));
    const everything = args.some((a) => !a.startsWith("-") && (WHOLE.test(a) || wholeFolder(a, home))) || WINDOWS_WHOLE.test(targets.join(" ").toLowerCase().replace(/\\/g, "/"));
    if (recursive && everything) return "this would delete the whole home folder, a system folder or the whole disk";
  }
  if (/^format(\.com)?\s+[a-z]:/i.test(words) || /^(format-volume|clear-disk|remove-partition)(\s|$)/i.test(words)) return "this would format a disk";
  if (/^mkfs(\.|\s|$)/.test(words)) return "this would format a disk";
  if (/^dd\s.*\bof=\/dev\/(sd|nvme|hd|vd|disk|mmcblk)/.test(words)) return "this would overwrite a disk";
  if (/^(shutdown|reboot|halt|poweroff|stop-computer|restart-computer)(\s|$)/i.test(words)) return "this would switch the computer off";
  if (/^chmod\s+(-[a-zA-Z]*R[a-zA-Z]*\s+)\S+\s+\/(\s|$)/.test(words) || /^chown\s+(-[a-zA-Z]*R[a-zA-Z]*\s+)\S+\s+\/(\s|$)/.test(words)) return "this would change the rights of every file on the computer";
  if (/>\s*\/dev\/(sd|nvme|hd|vd|disk|mmcblk)/.test(words)) return "this would overwrite a disk";
  if (/^kill\s+(?:-\S+\s+)*-1(\s|$)/.test(words)) return "this would stop every program you have running";
  return undefined;
}

/**
 * The reason a shell command may never run, or nothing. It is judged as the shell will run it, in the way a POSIX shell reads it and in
 * the way Windows' shells do: quotes, escapes, variables, wrappers (`sudo`, `env`, `xargs`…), `sh -c`, `eval` and heredocs do not hide it.
 */
function blockedCommand(command: string, home: string): string | undefined {
  for (const mode of ["posix", "windows"] as const) {
    for (const c of shellView(command, mode).cmds) {
      const why = blockedLine(c.words.join(" "), home) ?? c.redirects.map((r) => blockedLine(`${r.op} ${r.target}`, home)).find(Boolean);
      if (why) return why;
    }
  }
  if (/:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/.test(command)) return "this is a fork bomb";
  return undefined;
}

/**
 * What the agent may never do, whatever the mode and whatever the rules say: wipe the computer, format a disk, write over the
 * system. Short on purpose: it stops the disasters, and everything else is left to the mode and to the person's rules.
 * Returns the reason, or nothing when the call is not one of these.
 */
export function hardBlock(tool: string, args: Record<string, unknown>, cwd: string, p: Paths = nativePaths): string | undefined {
  if (tool === "Bash") return blockedCommand(String(args.command ?? ""), p.home ?? homeFrom());
  for (const file of changedPaths(tool, args)) {
    const full = p.resolve(cwd, expandHome(file, p.home ?? homeFrom())).replace(/\\/g, "/");
    const caseless = caselessFor(p);
    if ((caseless ? SYSTEM_DIRS_CASELESS : SYSTEM_DIRS).test(full) || WINDOWS_SYSTEM_DIRS.test(full)) return "this would change a system folder";
    if ((caseless ? OWN_PERMISSIONS_CASELESS : OWN_PERMISSIONS).test(full)) return "this would change what the agent is allowed to do";
  }
  return undefined;
}
