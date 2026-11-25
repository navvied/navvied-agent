import { hardBlock } from "./rules.ts";
import { riskOf } from "./risk.ts";
import { programName, shellView, type Flat } from "./shell-scan.ts";

/** Files that hold keys or passwords. */
const SECRET_FILE = /(^|[/\\~])(\.ssh|\.aws|\.gnupg|\.netrc|\.npmrc|\.pgpass|\.docker\/config\.json|\.kube\/config|\.git-credentials|id_(rsa|ed25519|ecdsa|dsa)|credentials(\.json)?|\.env(\.[\w.-]+)?|shadow)([/\\.\s]|$)/i;
const SECRET_VAR = /\$\{?[A-Z0-9_]*(KEY|TOKEN|SECRET|PASSW(OR)?D|CREDENTIAL)[A-Z0-9_]*\}?/;
const SENDS = /^(nc|ncat|netcat|socat|telnet|scp|sftp|rsync|ftp|tftp)$/;
const REACHES = /^(curl|wget|http|https|xh)$/;
const DELETES = /^(rm|rmdir|shred|unlink|wipefs|blkdiscard)$/;
const BODY_FLAG = /^(-d|--data(-\w+)?|-F|--form(-string)?|-T|--upload-file|--json|--post-(data|file)|--body-(data|file))$|^-d.+/;

const hasBody = (args: string[]): boolean => args.some((a, i) => BODY_FLAG.test(a) || ((a === "-X" || a === "--request") && /^(POST|PUT|PATCH|DELETE)$/i.test(args[i + 1] ?? "")));

function ofCommand(c: Flat): string[] {
  const head = programName(c.words[0] ?? ""), args = c.words.slice(1);
  const out: string[] = [];
  const findDeletes = head === "find" && (args.includes("-delete") || args.some((a, i) => /^-exec(dir)?$/.test(a) && DELETES.test(programName(args[i + 1] ?? ""))));
  if (DELETES.test(head) || findDeletes) out.push("This deletes files.");
  if (SENDS.test(head) || (REACHES.test(head) && hasBody(args))) out.push("This sends data to another computer.");
  if (c.words.some((w) => SECRET_FILE.test(w)) || c.redirects.some((r) => r.op.startsWith("<") && SECRET_FILE.test(r.target)) || (/^(env|printenv)$/.test(head) && args.length === 0)) out.push("This reads a file or a variable that holds keys or passwords.");
  if ((SENDS.test(head) || REACHES.test(head)) && c.words.some((w) => SECRET_VAR.test(w))) out.push("This sends a key or a password to another computer.");
  return out;
}

/**
 * What a command line that a plugin would run does, in words, read the way the permission check reads a shell command: deletes, sends,
 * secret reads, administrator rights, a download or decoded text run without looking, and anything built while it runs. A finding is
 * a note for the person and never decides; whether a command may run at all is `forbidden`.
 */
export function scanCommand(command: string, cwd = process.cwd()): string[] {
  const view = shellView(command);
  const out = new Set<string>();
  for (const f of view.found) out.add(f.reason);
  for (const c of view.cmds) for (const w of ofCommand(c)) out.add(w);
  const risk = riskOf("Bash", { command }, cwd);
  if (risk) out.add(risk.reason);
  return [...out].slice(0, 8);
}

/** The reason a command may never run (the hard floor), or nothing. */
export const forbidden = (command: string, cwd = process.cwd()): string | undefined => hardBlock("Bash", { command }, cwd);
