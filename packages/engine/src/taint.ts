import { homedir, tmpdir } from "node:os";
import { gitParts, LAST_ONLY, WRITERS, type Risk } from "./risk.ts";
import { nativePaths, type Paths } from "./rules.ts";
import { programName, shellView, type Flat } from "./shell-scan.ts";
import { changedPaths, readPaths } from "./tools/changed.ts";
import type { Tool } from "./types.ts";

/**
 * What this turn has read from outside (a page, a search, a connected service), kept so that two things can be told: that something was read (what the
 * agent does next may have been put in its head by it), and whether a call carries a long piece of it word for word. One per turn: the next turn
 * starts from the person's own words.
 */
const SHINGLE = 40;
const KEEP = 400_000;
const BASE = 257;
const TOP = [...Array(SHINGLE)].reduce<number>((p) => Math.imul(p, BASE), 1);
const flat = (t: string): string => t.replace(/\s+/g, " ");

/** The hash of every run of `SHINGLE` characters of a text, with where it ends. */
function* runs(text: string): Generator<[number, number]> {
  let h = 0;
  for (let i = 0; i < text.length; i++) {
    h = (Math.imul(h, BASE) + text.charCodeAt(i)) | 0;
    if (i >= SHINGLE) h = (h - Math.imul(text.charCodeAt(i - SHINGLE), TOP)) | 0;
    if (i >= SHINGLE - 1) yield [h, i + 1];
  }
}

const strings = (v: unknown, depth = 0): string[] => (typeof v === "string" ? [v] : depth < 3 && typeof v === "object" && v !== null ? Object.values(v).flatMap((x) => strings(x, depth + 1)) : []);

export class Outside {
  #text = "";
  #seen = false;
  #index: Set<number> | undefined;

  /** Whether any text from outside was read since the turn began. */
  get seen(): boolean { return this.#seen; }

  note(text: string): void {
    this.#seen = true;
    this.#text = `${this.#text} ${flat(text)}`.slice(-KEEP);
    this.#index = undefined;
  }

  reset(): void { this.#seen = false; this.#text = ""; this.#index = undefined; }

  /** Whether a call's arguments hold a run of at least 40 characters that was read from outside, word for word (a short phrase is a coincidence; this is a copy). */
  copied(args: Record<string, unknown>): boolean {
    if (!this.#text) return false;
    this.#index ??= new Set([...runs(this.#text)].map(([h]) => h));
    for (const s of strings(args)) {
      const text = flat(s).slice(0, 100_000);
      for (const [h, end] of runs(text)) {
        if (!this.#index.has(h)) continue;
        const piece = text.slice(end - SHINGLE, end);
        if ((piece.match(/[A-Za-z0-9]/g)?.length ?? 0) >= 16 && this.#text.includes(piece)) return true;
      }
    }
    return false;
  }
}

/** The tools of a program that runs its own tools (its web tools, and the services connected to it), which have no `Tool` to say so. */
export const fromOutsideName = (name: string): boolean => name === "WebFetch" || name === "WebSearch" || name.startsWith("mcp__");

/** The words of a card for a call that holds text read from a web page. */
export const withOrigin = (title: string, copied: boolean | undefined): string => (copied ? `This contains text from a web page: ${title}` : title);

const risk = (key: string, what: string, phrase: string): Risk => ({ key: `outside:${key}`, reason: `Text from the web or a connected service was read this turn, and now ${what}.`, phrase });

/** Places that are not the project but are no one's: the null device and the computer's own scratch folder. */
const DEVICE = /^\/dev\/(null|zero|stdout|stderr|tty)$/;

/** Whether a place is outside the project (and not scratch space). A path with an expansion that is not known is outside: it cannot be shown to be inside. */
function away(target: string, cwd: string, p: Paths): boolean {
  const t = target.replace(/\\/g, "/").replace(/^(~|\$HOME|\$\{HOME\})(?=\/|$)/, (process.env.HOME || homedir()).replace(/\\/g, "/"));
  if (!t || DEVICE.test(t)) return false;
  if (/[$`]/.test(t) || (p.sep === "/" && /^[a-z]:\//i.test(t))) return true;
  const full = p.resolve(cwd, t);
  const inside = (root: string): boolean => { const r = p.relative(p.resolve(root), full); return r !== ".." && !r.startsWith(`..${p.sep}`) && !r.startsWith("../") && !p.isAbsolute(r); };
  return !inside(cwd) && !inside(tmpdir());
}

/** Files that keep keys and passwords: a shell's, a cloud's, a person's. An example file for one is not. */
const SECRET = /(?:^|[/=@:])(?:\.(?:ssh|gnupg|aws|kube|azure|docker)(?:\/|$)|\.(?:netrc|npmrc|pypirc|pgpass|git-credentials)$|_netrc$|\.env(?:\.(?!(?:example|sample|template|dist)$)[\w.-]+)?$)|(?:^|\/)id_(?:rsa|dsa|ecdsa|ed25519)$|^\/etc\/(?:shadow|gshadow|sudoers)$|\.(?:pem|key|p12|pfx)$/i;
const secret = (path: string): boolean => SECRET.test(path.replace(/\\/g, "/"));

/** Programs that send what they are given to another computer, whatever the arguments. */
const SENDERS = /^(scp|sftp|ssh|ftp|tftp|nc|ncat|netcat|socat|telnet|mail|mailx|sendmail|msmtp|mutt)$/;
/** Programs that start something for later. */
const LATER = /^(crontab|at|batch|schtasks)$/;
const MODIFYING = /^(post|put|patch|delete)$/i;

/** Whether one command sends data away: a request that carries a body or a changing method, a push, a copy to another computer. */
function sends(head: string, w: string[]): boolean {
  const args = w.slice(1);
  const method = (re: RegExp): boolean => args.some((a, i) => re.test(a) && (MODIFYING.test(args[i + 1] ?? "") || MODIFYING.test(a.replace(/^[^=]*=|^-X/, ""))));
  if (head === "curl") return args.some((a) => /^-[a-zA-Z]*[dFT]/.test(a) || /^--(data|form|upload-file|json)/.test(a)) || method(/^(-X|--request)(=|$|[A-Za-z])/);
  if (head === "wget") return args.some((a) => /^--(post-data|post-file|body-data|body-file)/.test(a)) || method(/^--method/);
  if (/^(invoke-webrequest|iwr|invoke-restmethod|irm)$/.test(head)) return args.some((a) => /^-body$/i.test(a)) || args.some((a, i) => /^-method$/i.test(a) && MODIFYING.test(args[i + 1] ?? ""));
  if (head === "git") return gitParts(w).sub === "push";
  if (head === "rsync") return args.some((a) => /^[^/\s-][^/\s]*:|^rsync:\/\//.test(a));
  return SENDERS.test(head);
}

/** The places a command writes: redirects, the programs that write files, and where a download is saved. */
function writes(c: Flat): string[] {
  const head = programName(c.words[0] ?? "");
  const args = c.words.slice(1);
  const out = c.redirects.filter((r) => /^[>&]|^>>/.test(r.op) || r.op === "<>").map((r) => r.target);
  if (WRITERS.has(head) && !(head === "sed" && !args.some((a) => /^-[a-zA-Z]*i/.test(a) || a === "--in-place"))) {
    const targets = args.filter((a) => !a.startsWith("-"));
    out.push(...(LAST_ONLY.test(head) ? targets.slice(-1) : targets).map((t) => t.replace(/^of=/, "")));
  }
  if (head === "curl") args.forEach((a, i) => { if (/^(-o|--output)$/.test(a)) out.push(args[i + 1] ?? ""); else if (/^--output=/.test(a)) out.push(a.slice(9)); });
  if (head === "wget") args.forEach((a, i) => { if (/^(-O|-P|--output-document|--directory-prefix)$/.test(a)) out.push(args[i + 1] ?? ""); else if (/^--(output-document|directory-prefix)=/.test(a)) out.push(a.slice(a.indexOf("=") + 1)); });
  return out;
}

/**
 * What is asked about once a turn has read text from outside, even where the mode asks for nothing: a page can write instructions, and the
 * actions an instruction would need to do harm without touching the project are the ones named here. Writing inside the project, reading it, running
 * its programs and fetching a page are not in the list: that is the work a person asks for after "read this page". The reason is said to the person.
 */
export function afterOutside(tool: Pick<Tool, "name" | "askAfterOutside">, args: Record<string, unknown>, cwd: string, p: Paths = nativePaths): Risk | undefined {
  if (tool.askAfterOutside) return risk("later", "something is set to run later", "scheduling after the web was read");
  const secrets = (): Risk => risk("secret", "a file that holds secrets is read", "reading secret files after the web was read");
  if (readPaths(tool.name, args).some(secret)) return secrets();
  if (changedPaths(tool.name, args).some((f) => away(f, cwd, p))) return risk("write", "a file outside the project is changed", "changes outside the project after the web was read");
  if (tool.name !== "Bash" || typeof args.command !== "string") return undefined;
  const cmds = shellView(args.command).cmds;
  const reads = cmds.filter((c) => !/^(echo|printf)$/.test(programName(c.words[0] ?? "")));
  if (reads.some((c) => [...c.words.slice(1), ...c.redirects.filter((r) => r.op.includes("<")).map((r) => r.target)].some(secret))) return secrets();
  if (cmds.some((c) => sends(programName(c.words[0] ?? ""), c.words))) return risk("send", "a command sends data over the network", "sending data away after the web was read");
  if (cmds.some((c) => LATER.test(programName(c.words[0] ?? "")))) return risk("later", "something is set to run later", "scheduling after the web was read");
  if (cmds.some((c) => writes(c).some((t) => away(t, cwd, p)))) return risk("write", "a file outside the project is changed", "changes outside the project after the web was read");
  return undefined;
}
