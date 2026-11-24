import { isAbsolute } from "node:path";
import { caselessFor, nativePaths, splitCommand, type Paths } from "./rules.ts";

/**
 * What is asked about even when the person said "do not ask again", and in Auto mode: things that can be done, but not undone.
 * `key` is the kind of thing: a permission given for it covers that kind and nothing else (not "every git command"). `reason` is
 * said to the person in plain words; `phrase` finishes "Always allow …".
 */
export interface Risk { key: string; reason: string; phrase: string }

const risk = (key: string, reason: string, phrase: string): Risk => ({ key: `risk:${key}`, reason, phrase });

const words = (part: string): string[] => part.replace(/["']/g, "").trim().split(/\s+/);

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

function ofCommand(part: string): Risk | undefined {
  const plain = part.replace(/^\s*(env\s+\S+=\S+\s+)*/, "").trim();
  const inner = /^(?:ba|z|da|k)?sh\s+-[a-z]*c\s+(["'])([\s\S]*)\1\s*$/.exec(plain)?.[2];
  if (inner !== undefined) { const why = ofBash(inner); if (why) return why; }
  const w = words(plain.replace(/^(sudo|doas)\s+/, ""));
  const head = (w[0] ?? "").replace(/^.*\//, "");
  if (/^(sudo|doas)\s/.test(plain)) return risk("sudo", "This runs with administrator rights.", "commands run as administrator");
  if (head === "git") return ofGit(w);
  if (head === "rm") {
    const args = w.slice(1);
    const recursive = args.some((a) => /^-[a-zA-Z]*[rR]/.test(a) || a === "--recursive");
    const targets = args.filter((a) => !a.startsWith("-"));
    if (recursive && targets.some((t) => !narrow(t))) return risk("delete-wide", "This deletes folders outside the project, or a very wide set of files.", "deleting wide sets of files");
    return undefined;
  }
  if ((head === "chmod" || head === "chown" || head === "chgrp") && w.some((a) => /^-[a-zA-Z]*R/.test(a) || a === "--recursive")) return risk("chmod-recursive", "This changes the rights of many files at once.", "changing rights of many files");
  if ((head === "kill" || head === "pkill" || head === "killall") && w.some((a) => /^-(9|KILL|SIGKILL)$/.test(a))) return risk("kill-force", "This stops programs without letting them save.", "force-stopping programs");
  if (/^(docker|podman)$/.test(head) && ((w[1] === "system" && w[2] === "prune") || (w[1] === "volume" && w[2] === "prune") || (/^(rm|rmi)$/.test(w[1] ?? "") && w.some((a) => a === "-f" || a === "--force")))) return risk("docker-remove", "This removes containers, images or volumes, with their data.", "removing containers and volumes");
  if (head === "kubectl" && /^(delete|drain|replace)$/.test(w[1] ?? "")) return risk("kubectl-delete", "This deletes things in a cluster.", "deleting things in a cluster");
  if (/^(npm|pnpm|yarn|bun)$/.test(head) && w[1] === "publish") return risk("publish", "This publishes a package for everyone.", "publishing packages");
  if (head === "terraform" && /^(destroy|apply)$/.test(w[1] ?? "")) return risk("terraform", "This changes or destroys real infrastructure.", "changing infrastructure");
  return undefined;
}

/**
 * The addresses where a cloud machine's provider answers with what the machine may do and its keys (AWS and most others, AWS over IPv6, Google, Alibaba), spelt as a
 * name, as dotted digits, as one number in decimal or hex, or with octal parts. A command that reaches one of them from here would hand the keys to whoever
 * wrote the command, which is also what a page that was read can ask for; the fetch tool refuses them, so a shell must not be the way round.
 */
const METADATA = /(?<![\w.])(?:169\.254\.169\.254|0*251\.0*376\.0*251\.0*376|0xa9\.?0xfe\.?0xa9\.?0xfe|0xa9fea9fe|2852039166|169\.16689662|169\.254\.43518|100\.100\.100\.200|metadata\.google\.internal|metadata\.goog|instance-data(?:\.ec2\.internal)?)(?![\w-]|\.\w)|\[?fd00:ec2::254\]?/i;

/** Something downloaded and handed straight to a shell, or a destructive statement for a database. */
function ofWhole(command: string): Risk | undefined {
  if (METADATA.test(command)) return risk("cloud-metadata", "This reaches the address where a cloud machine's provider hands out its keys and passwords.", "reaching a cloud metadata address");
  if (/\b(curl|wget)\b[^|;&]*\|\s*(sudo\s+)?(ba|z|da|k)?sh\b/.test(command)) return risk("pipe-to-shell", "This runs a program that was just downloaded, without looking at it first.", "running downloaded programs");
  if (/\b(drop\s+(table|database|schema)|truncate\s+table)\b/i.test(command)) return risk("sql-drop", "This deletes a table or a database.", "deleting tables or databases");
  if (/(>>?|\btee(\s+-a)?)\s*(~|\$HOME|\/home\/[^/\s]+|\/Users\/[^/\s]+)?\/?\.(bashrc|zshrc|profile|bash_profile|zprofile|ssh\/|gitconfig|npmrc|netrc|gnupg\/)/.test(command)) return risk("protected-path", "This changes a file that sets up your shell, your keys or your git identity.", "changes to setup files");
  return undefined;
}

function ofBash(command: string, depth = 0): Risk | undefined {
  const whole = ofWhole(command);
  if (whole) return whole;
  if (depth > 3) return undefined;
  for (const part of splitCommand(command)) { const why = ofCommand(part); if (why) return why; }
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
  if (tool === "Bash" && typeof args.command === "string") return ofBash(args.command);
  if ((tool === "Write" || tool === "Edit") && typeof args.file_path === "string") return ofPath(args.file_path, cwd, p);
  return undefined;
}

/** Commands that only look: they never need asking about, in any mode. */
const LOOKING = /^(ls|ll|la|pwd|cat|head|tail|wc|date|whoami|id|uname|hostname|which|type|file|stat|du|df|tree|basename|dirname|realpath|readlink|sort|uniq|cut|tr|diff|cmp|grep|egrep|fgrep|rg|ag|jq|env|printenv|true|false|test|\[)$/;
const LOOKING_GIT = /^(status|diff|log|show|blame|grep|ls-files|ls-tree|rev-parse|rev-list|describe|shortlog|remote|config|tag|branch|stash|reflog)$/;

/** Whether a shell command only looks at things. Anything that could write (a redirect, a substitution, find -exec) is not. */
export function onlyLooks(command: string): boolean {
  if (/[<>]|\$\(|`|\btee\b/.test(command.replace(/2>&1|>\s*\/dev\/null/g, ""))) return false;
  const parts = splitCommand(command);
  return parts.length > 0 && parts.every((part) => {
    const w = words(part);
    const head = (w[0] ?? "").replace(/^.*\//, "");
    if (head === "git") {
      const { sub, rest } = gitParts(w);
      if (!LOOKING_GIT.test(sub)) return false;
      // `branch`, `tag`, `stash`, `remote` and `config` also change things when given more than a listing.
      if (sub === "branch" || sub === "tag") return rest.every((a) => /^-(a|r|l|v|vv|-list|-all|-remotes|-contains|-merged|-no-merged)$/.test(a));
      if (sub === "stash") return rest[0] === "list" || rest[0] === "show";
      if (sub === "remote") return rest.length === 0 || rest[0] === "-v" || rest[0] === "show" || rest[0] === "get-url";
      if (sub === "config") return rest[0] === "--get" || rest[0] === "--list" || rest[0] === "-l";
      return true;
    }
    if (head === "find") return !w.some((a) => /^-(exec|execdir|delete|ok|fprint|fls)/.test(a));
    if (head === "sed" || head === "awk") return false;
    return LOOKING.test(head);
  });
}
