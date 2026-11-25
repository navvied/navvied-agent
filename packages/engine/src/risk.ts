import { isAbsolute, posix } from "node:path";
import { changedPaths } from "./tools/changed.ts";
import { caselessFor, nativePaths, type Paths } from "./rules.ts";
import { programName, shellView, type Flat } from "./shell-scan.ts";

/**
 * What is asked about even when the person said "do not ask again", and in Auto mode: things that can be done, but not undone.
 * `key` is the kind of thing: a permission given for it covers that kind and nothing else (not "every git command"). `reason` is
 * said to the person in plain words; `phrase` finishes "Always allow …".
 */
export interface Risk { key: string; reason: string; phrase: string }

const risk = (key: string, reason: string, phrase: string): Risk => ({ key: `risk:${key}`, reason, phrase });

/** A target `rm -r` may take without asking: a plain path inside the project. Everything wide, or outside it, is asked about. */
const narrow = (target: string): boolean => !!target && !isAbsolute(target) && !/^(~|\$|\.{1,2}$|\.\.\/|\*|\.\/\*)/.test(target) && !target.includes("..") && !/^[*.]+$/.test(target);

/** The subcommand of a git command and what follows it, past options such as `-C dir` and `-c name=value`. */
function gitParts(w: string[]): { sub: string; rest: string[] } {
  let i = 1;
  while (i < w.length && w[i]!.startsWith("-")) i += w[i] === "-C" || w[i] === "-c" ? 2 : 1;
  return { sub: w[i] ?? "", rest: w.slice(i + 1) };
}

function ofGit(w: string[]): Risk | undefined {
  const { sub, rest } = gitParts(w);
  const flag = (re: RegExp): boolean => rest.some((a) => re.test(a));
  if (sub === "reset" && flag(/^--h(a(r(d)?)?)?$/)) return risk("git-reset-hard", "This throws away every change that has not been saved in a commit.", "git reset --hard");
  if (sub === "push") {
    if (flag(/^--forc/) || flag(/^-[a-zA-Z]*f[a-zA-Z]*$/) || rest.some((a) => /^\+\S/.test(a))) return risk("git-force-push", "A force push rewrites the history of the remote branch, and what others pushed there can be lost.", "force pushes");
    if (flag(/^--delete$/) || rest.some((a) => /^:\S+/.test(a))) return risk("git-delete-remote", "This deletes a branch on the remote.", "deleting remote branches");
  }
  if (sub === "clean" && flag(/^-[a-zA-Z]*f/)) return risk("git-clean", "This deletes files that are not in git, and they cannot be brought back.", "git clean");
  if (sub === "branch" && flag(/^-D$|^--delete$/) && flag(/^-D$|^-f$|^--force$/)) return risk("git-branch-delete", "This deletes a branch even if it was not merged.", "force-deleting branches");
  if ((sub === "checkout" && (rest.includes("--") && rest.some((a) => a === "." || a === ":/") || (rest.length === 1 && rest[0] === "."))) || (sub === "restore" && rest.some((a) => a === "." || a === ":/") && !flag(/^--staged$/))) return risk("git-discard", "This throws away changes that have not been saved in a commit.", "discarding changes");
  if (sub === "stash" && (rest[0] === "drop" || rest[0] === "clear")) return risk("git-stash-drop", "This deletes saved work for good.", "dropping stashes");
  if (sub === "commit" && flag(/^--amend$/)) return risk("git-amend", "This rewrites the last commit.", "amending commits");
  if (sub === "filter-branch" || (sub === "reflog" && rest[0] === "expire") || (sub === "gc" && flag(/^--prune/))) return risk("git-rewrite", "This rewrites or erases git history.", "rewriting git history");
  return undefined;
}

/** A target a delete may take without asking: inside the project, and not a whole folder. */
const contained = (t: string, dyn: boolean): boolean => !dyn && narrow(t) && !t.startsWith("-");

/** Where a command writes that is the person's setup or the system's own: a folder every program depends on. */
const SYSTEM = /^\/(etc|boot|usr|bin|sbin|lib|lib64|System|dev\/(sd|nvme|hd|vd|disk|mmcblk)|proc|sys)(\/|\d|$)/;
const LAST_ONLY = /^(cp|mv|install|ln|sed|chmod|chown|chgrp|truncate)$/;
const WRITERS = new Set(["tee", "cp", "mv", "install", "ln", "truncate", "touch", "mkdir", "rm", "rmdir", "chmod", "chown", "chgrp", "sed", "dd"]);

/** The system's own folders on Windows, spelt with `/`: whatever runs the command, PowerShell or cmd writes them like this, and so does Git Bash as `/c/Windows`. A file directly on a drive's root is the system's too (only when it is spelt with its drive letter). */
const WINDOWS_SYSTEM = /^[a-z]:\/(windows|program files|program files \(x86\)|programdata)(\/|$)/i;
const DRIVE_ROOT_FILE = /^[a-z]:\/[^/]*$/i;
const GIT_BASH_DRIVE = /^\/([a-z])(\/.*)?$/i;

/**
 * Where a command writes, judged the way the shell that runs it reads the path, not the way this computer does: `/etc/hosts` in a command is the
 * system's file on every computer (on Windows too, where the shell is Git Bash), and `C:\Windows\x` is the system's on every computer.
 * Only a path that is not absolute is made from the folder the command runs in, by this computer's rules.
 */
function ofWrite(target: string, cwd: string, p: Paths): Risk | undefined {
  if (!target || target === "/dev/null" || /^\/dev\/(stdout|stderr|tty)$/.test(target)) return undefined;
  const flat = target.replace(/\\/g, "/");
  const posixAbsolute = target.startsWith("/");
  const full = posixAbsolute ? posix.normalize(flat) : /^[a-z]:\//i.test(flat) ? flat.slice(0, 2) + posix.normalize(flat.slice(2)) : p.resolve(cwd, target).replace(/\\/g, "/");
  const drive = posixAbsolute ? GIT_BASH_DRIVE.exec(full) : null;
  const asWindows = drive ? `${drive[1]}:${drive[2] ?? "/"}` : /^[a-z]:\//i.test(full) ? full : undefined;
  if (SYSTEM.test(full) || (asWindows !== undefined && WINDOWS_SYSTEM.test(asWindows)) || (!posixAbsolute && DRIVE_ROOT_FILE.test(full))) return risk("system-write", "This changes a file of the system itself.", "changes to system files");
  return ofPath(target, cwd, p);
}

function ofFlat(c: Flat, cwd: string, p: Paths): Risk | undefined {
  const w = c.words;
  const head = programName(w[0] ?? "");
  const args = w.slice(1);
  for (const r of c.redirects) { if (/^[>&]|^>>/.test(r.op) || r.op === "<>") { const why = ofWrite(r.target, cwd, p); if (why) return why; } }
  // Administrator rights are asked about as such, whatever they run.
  if (c.sudo) return risk("sudo", "This runs with administrator rights.", "commands run as administrator");
  const inner = ofProgram(head, w, c, cwd, p);
  if (inner) return inner;
  if (WRITERS.has(head) && !(head === "sed" && !args.some((a) => /^-[a-zA-Z]*i/.test(a) || a === "--in-place"))) {
    const targets = args.filter((a) => !a.startsWith("-"));
    for (const t of LAST_ONLY.test(head) ? targets.slice(-1) : targets) { const why = ofWrite(t.replace(/^of=/, ""), cwd, p); if (why) return why; }
  }
  return undefined;
}

function ofProgram(head: string, w: string[], c: Flat, cwd: string, p: Paths): Risk | undefined {
  const args = w.slice(1);
  if (head === "git") return ofGit(w);
  if (head === "rm") {
    const recursive = args.some((a) => /^-[a-zA-Z]*[rR]/.test(a) || a === "--recursive");
    if (recursive && args.some((a, i) => !a.startsWith("-") && !contained(a, c.dyn[i + 1] ?? false))) return risk("delete-wide", "This deletes folders outside the project, or a very wide set of files.", "deleting wide sets of files");
    if (c.fed === "xargs") return risk("delete-piped", "This deletes files named by another command, which cannot be checked first.", "deleting files named by another command");
    return undefined;
  }
  if (head === "find") {
    const starts = args.slice(0, args.findIndex((a) => a.startsWith("-") || a === "!" || a === "(") < 0 ? args.length : args.findIndex((a) => a.startsWith("-") || a === "!" || a === "("));
    const deletes = args.includes("-delete") || args.some((a, i) => /^-(exec|execdir|ok|okdir)$/.test(a) && /^(rm|rmdir|shred|unlink)$/.test(programName(args[i + 1] ?? "")));
    const filtered = args.some((a) => /^-(i?name|i?path|i?regex|type|mtime|mmin|atime|ctime|newer|size|empty|user|group|perm|i?wholename)$/.test(a));
    if (deletes && (!filtered || !starts.every((t) => contained(t, false) || t === "."))) return risk("delete-wide", "This deletes folders outside the project, or a very wide set of files.", "deleting wide sets of files");
    return undefined;
  }
  if (head === "dd") {
    const target = args.find((a) => a.startsWith("of="))?.slice(3);
    if (target && ofWrite(target, cwd, p)) return risk("dd-write", "This writes raw data over a file or a disk.", "writing raw data over files");
    if (target && /^\/dev\//.test(target) && !/^\/dev\/(null|zero|stdout|stderr)$/.test(target)) return risk("dd-write", "This writes raw data over a file or a disk.", "writing raw data over files");
    return undefined;
  }
  if (/^(chmod|chown|chgrp)$/.test(head) && args.some((a) => /^-[a-zA-Z]*R/.test(a) || a === "--recursive")) return risk("chmod-recursive", "This changes the rights of many files at once.", "changing rights of many files");
  if (/^(kill|pkill|killall)$/.test(head) && args.some((a) => /^-(9|KILL|SIGKILL)$/.test(a))) return risk("kill-force", "This stops programs without letting them save.", "force-stopping programs");
  if (/^(docker|podman)$/.test(head) && ((w[1] === "system" && w[2] === "prune") || (w[1] === "volume" && w[2] === "prune") || (/^(rm|rmi)$/.test(w[1] ?? "") && w.some((a) => a === "-f" || a === "--force")))) return risk("docker-remove", "This removes containers, images or volumes, with their data.", "removing containers and volumes");
  if (head === "kubectl" && /^(delete|drain|replace)$/.test(w[1] ?? "")) return risk("kubectl-delete", "This deletes things in a cluster.", "deleting things in a cluster");
  if (/^(npm|pnpm|yarn|bun)$/.test(head) && w[1] === "publish") return risk("publish", "This publishes a package for everyone.", "publishing packages");
  if (head === "terraform" && /^(destroy|apply)$/.test(w[1] ?? "")) return risk("terraform", "This changes or destroys real infrastructure.", "changing infrastructure");
  if (/^(psql|mysql|mariadb|sqlite3|sqlcmd|mongosh|duckdb)$/.test(head) && SQL_DROP.test(`${args.join(" ")} ${c.stdin ?? ""}`)) return risk("sql-drop", "This deletes a table or a database.", "deleting tables or databases");
  if (/^(shred|wipefs|blkdiscard)$/.test(head)) return risk("delete-wide", "This erases files or a disk for good.", "deleting wide sets of files");
  return undefined;
}

const SQL_DROP = /\b(drop\s+(table|database|schema)|truncate\s+table)\b/i;

/**
 * The addresses where a cloud machine's provider answers with what the machine may do and its keys (AWS and most others, AWS over IPv6, Google, Alibaba), spelt as a
 * name, as dotted digits, as one number in decimal or hex, or with octal parts. A command that reaches one of them from here would hand the keys to whoever
 * wrote the command, which is also what a page that was read can ask for; the fetch tool refuses them, so a shell must not be the way round.
 */
const METADATA = /(?<![\w.])(?:169\.254\.169\.254|0*251\.0*376\.0*251\.0*376|0xa9\.?0xfe\.?0xa9\.?0xfe|0xa9fea9fe|2852039166|169\.16689662|169\.254\.43518|100\.100\.100\.200|metadata\.google\.internal|metadata\.goog|instance-data(?:\.ec2\.internal)?)(?![\w-]|\.\w)|\[?fd00:ec2::254\]?/i;

function ofBash(command: string, cwd: string, p: Paths): Risk | undefined {
  const view = shellView(command);
  if (METADATA.test(command) || view.cmds.some((c) => c.words.some((w) => METADATA.test(w)))) return risk("cloud-metadata", "This reaches the address where a cloud machine's provider hands out its keys and passwords.", "reaching a cloud metadata address");
  const f = view.found[0];
  if (f) return risk(f.key, f.reason, f.phrase);
  for (const c of view.cmds) { const why = ofFlat(c, cwd, p); if (why) return why; }
  return undefined;
}

/** Files the agent should not change without the person's say-so: what sets up their shell and keys, git's own records, and navvied's setup. */
const PROTECTED = /(^|\/)(\.git\/(?!info\/exclude$)|\.ssh\/|\.gnupg\/|\.aws\/|\.bashrc$|\.bash_profile$|\.zshrc$|\.zprofile$|\.profile$|\.gitconfig$|\.npmrc$|\.netrc$|\.mcp\.json$|\.husky\/|\.config\/navvied\/|\.navvied\/(hooks|settings)[^/]*$)/;

const PROTECTED_CASELESS = new RegExp(PROTECTED.source, "i");

function ofPath(file: string, cwd: string, p: Paths): Risk | undefined {
  const full = p.resolve(cwd, file).replace(/\\/g, "/");
  const inside = p.relative(p.resolve(cwd), full).replace(/\\/g, "/");
  const protectedPath = caselessFor(p) ? PROTECTED_CASELESS : PROTECTED;
  return protectedPath.test(full) || protectedPath.test(inside) ? risk("protected-path", "This changes a file that sets up your shell, your keys, git itself or navvied.", "changes to setup files") : undefined;
}

/** The risk of a tool call, or nothing when there is none worth asking about. */
export function riskOf(tool: string, args: Record<string, unknown>, cwd: string, p: Paths = nativePaths): Risk | undefined {
  if (tool === "Bash" && typeof args.command === "string") return ofBash(args.command, cwd, p);
  for (const file of changedPaths(tool, args)) { const found = ofPath(file, cwd, p); if (found) return found; }
  return undefined;
}

/** Commands that only look: they never need asking about, in any mode. */
const LOOKING = /^(ls|ll|la|pwd|cat|head|tail|wc|date|whoami|id|uname|hostname|which|type|file|stat|du|df|tree|basename|dirname|realpath|readlink|sort|uniq|cut|tr|diff|cmp|grep|egrep|fgrep|rg|ag|jq|env|printenv|true|false|test|\[)$/;
const LOOKING_GIT = /^(status|diff|log|show|blame|grep|ls-files|ls-tree|rev-parse|rev-list|describe|shortlog|remote|config|tag|branch|stash|reflog)$/;

/** Whether a shell command only looks at things. Anything that could write (a redirect, a substitution, find -exec) is not. */
export function onlyLooks(command: string): boolean {
  if (/[<>]|\$\(|`|\btee\b/.test(command.replace(/2>&1|>\s*\/dev\/null/g, ""))) return false;
  const view = shellView(command);
  return view.cmds.length > 0 && view.found.length === 0 && view.cmds.every((c) => {
    if (c.sudo || c.fed) return false;
    const head = programName(c.words[0] ?? "");
    if (head === "git") {
      const { sub, rest } = gitParts(c.words);
      if (!LOOKING_GIT.test(sub)) return false;
      // `branch`, `tag`, `stash`, `remote` and `config` also change things when given more than a listing.
      if (sub === "branch" || sub === "tag") return rest.every((a) => /^-(a|r|l|v|vv|-list|-all|-remotes|-contains|-merged|-no-merged)$/.test(a));
      if (sub === "stash") return rest[0] === "list" || rest[0] === "show";
      if (sub === "remote") return rest.length === 0 || rest[0] === "-v" || rest[0] === "show" || rest[0] === "get-url";
      if (sub === "config") return rest[0] === "--get" || rest[0] === "--list" || rest[0] === "-l";
      return true;
    }
    if (head === "find") return !c.words.some((a) => /^-(exec|execdir|delete|ok|fprint|fls)/.test(a));
    if (head === "sed" || head === "awk") return false;
    return LOOKING.test(head);
  });
}
