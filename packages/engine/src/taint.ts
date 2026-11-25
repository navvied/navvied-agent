import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { gitParts, LAST_ONLY, WRITERS, type Risk } from "./risk.ts";
import { nativePaths, type Paths } from "./rules.ts";
import { programName, shellView, type Flat } from "./shell-scan.ts";
import { carriesData, urlsIn, type Seen } from "./taint-carry.ts";
import { codeRisk } from "./taint-code.ts";
import { away, secret } from "./taint-place.ts";
import { changedPaths, readPaths } from "./tools/changed.ts";
import type { Tool } from "./types.ts";

const BASE = 257;
const KEEP = 400_000;
const flat = (t: string): string => t.replace(/\s+/g, " ");
const strings = (v: unknown, depth = 0): string[] => (typeof v === "string" ? [v] : depth < 3 && typeof v === "object" && v !== null ? Object.values(v).flatMap((x) => strings(x, depth + 1)) : []);

/**
 * Text kept so that a piece of it can be found word for word in something else: a run of `size` characters (with at least `alnum` letters and digits, so
 * that punctuation and padding are not a copy) is hashed at every position, and a hit is checked against the text itself.
 */
class Corpus {
  #text = "";
  #index: Set<number> | undefined;
  readonly #top: number;
  constructor(private readonly size: number, private readonly alnum: number) { this.#top = [...Array(size)].reduce<number>((p) => Math.imul(p, BASE), 1); }

  *#runs(text: string): Generator<[number, number]> {
    let h = 0;
    for (let i = 0; i < text.length; i++) {
      h = (Math.imul(h, BASE) + text.charCodeAt(i)) | 0;
      if (i >= this.size) h = (h - Math.imul(text.charCodeAt(i - this.size), this.#top)) | 0;
      if (i >= this.size - 1) yield [h, i + 1];
    }
  }

  add(text: string): void { this.#text = `${this.#text} ${flat(text)}`.slice(-KEEP); this.#index = undefined; }
  clear(): void { this.#text = ""; this.#index = undefined; }
  includes(value: string): boolean { return value !== "" && this.#text.includes(value); }

  copied(parts: readonly string[]): boolean {
    if (!this.#text) return false;
    this.#index ??= new Set([...this.#runs(this.#text)].map(([h]) => h));
    for (const s of parts) {
      const text = flat(s).slice(0, 100_000);
      for (const [h, end] of this.#runs(text)) {
        if (!this.#index.has(h)) continue;
        const piece = text.slice(end - this.size, end);
        if ((piece.match(/[A-Za-z0-9]/g)?.length ?? 0) >= this.alnum && this.#text.includes(piece)) return true;
      }
    }
    return false;
  }
}

/**
 * What this turn has read from outside (a page, a search, a connected service), kept so that three things can be told: that something was read (what the
 * agent does next may have been put in its head by it), whether a call carries a long piece of it word for word, and, for an address or a script, whether it
 * carries what only this computer knows (a file read this turn). It also holds the person's words and the files this turn wrote, which are what a call may
 * repeat or run without a page having had a hand in it. One per turn: the next turn starts from the person's own words.
 */
export class Outside implements Seen {
  #seen = false;
  readonly #page = new Corpus(40, 16);
  readonly #files = new Corpus(32, 20);
  #said = "";
  readonly #written = new Set<string>();

  /** Whether any text from outside was read since the turn began. */
  get seen(): boolean { return this.#seen; }

  note(text: string): void { this.#seen = true; this.#page.add(text); }

  /** The person's own words this turn. */
  say(text: string): void { this.#said = `${this.#said} ${flat(text)}`.slice(-KEEP); }

  /** The text of a file this turn read. */
  read(text: string): void { this.#files.add(text); }

  /** The files a call changes (a writing tool, a redirect, a download), so that a script made this turn can be told from one that was there before. */
  record(tool: string, args: Record<string, unknown>, cwd: string): void {
    const paths = changedPaths(tool, args);
    if (tool === "Bash" && typeof args.command === "string") for (const c of shellView(args.command).cmds) paths.push(...writes(c));
    for (const p of paths) if (p && !/[$`]/.test(p)) this.#written.add(resolve(cwd, p));
  }

  /** What a file written this turn holds now, when it is one. */
  script(path: string, cwd: string): string | undefined {
    const file = resolve(cwd, path);
    if (!this.#written.has(file)) return undefined;
    try { return readFileSync(file, "utf8").slice(0, 200_000); } catch { return undefined; }
  }

  reset(): void { this.#seen = false; this.#page.clear(); this.#files.clear(); this.#said = ""; this.#written.clear(); }

  mentions(text: string): boolean { return this.#said.includes(text) || this.#page.includes(text); }
  fromFiles(parts: string[]): boolean { return this.#files.copied(parts); }
  inFiles(value: string): boolean { return this.#files.includes(value); }

  /** Whether a call's arguments hold a run of at least 40 characters that was read from outside, word for word (a short phrase is a coincidence; this is a copy). */
  copied(args: Record<string, unknown>): boolean { return this.#page.copied(strings(args)); }
}

/** The tools of a program that runs its own tools (its web tools, and the services connected to it), which have no `Tool` to say so. */
export const fromOutsideName = (name: string): boolean => name === "WebFetch" || name === "WebSearch" || name.startsWith("mcp__");

/** The words of a card for a call that holds text read from a web page. */
export const withOrigin = (title: string, copied: boolean | undefined): string => (copied ? `From a web page: ${title}` : title);

const risk = (key: string, what: string, phrase: string): Risk => ({ key: `outside:${key}`, reason: `Web text was read this turn, and now ${what}.`, phrase });

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

/** What the turn knows, beyond the call itself, that decides whether a call carries what it should not. */
export interface Turn {
  outside?: Partial<Seen & Pick<Outside, "script">> | undefined;
  /** The values this conversation knows as secrets. */
  secrets?: readonly string[] | undefined;
}

const seenOf = (o: Turn["outside"]): Seen => ({ mentions: (t) => o?.mentions?.(t) ?? false, fromFiles: (p) => o?.fromFiles?.(p) ?? false, inFiles: (v) => o?.inFiles?.(v) ?? false });

/** Programs that fetch an address: a plain GET with data in its path or query string leaves as surely as a post. */
const FETCHERS = /^(curl|wget|invoke-webrequest|iwr|invoke-restmethod|irm|http|https|xh|aria2c)$/;
const SHELL_FILE = /\.(?:sh|bash|zsh|ksh)$/i;
const WINDOWS_FILE = /\.(?:ps1|bat|cmd)$/i;

const CODE = {
  send: () => risk("send", "a program sends data over the network", "sending data away after the web was read"),
  write: () => risk("write", "a program changes a file outside the project", "changes outside the project after the web was read"),
  secret: () => risk("secret", "a program reads a file that holds secrets", "reading secret files after the web was read"),
};

/** Whether a command fetches an address that carries something the page cannot have named: copied from a secret or a file, an encoded blob, or built while the command runs. */
function fetchesCarrying(cmds: Flat[], turn: Turn): boolean {
  const seen = seenOf(turn.outside);
  return cmds.some((c) => FETCHERS.test(programName(c.words[0] ?? "")) && c.words.some((w, i) => urlsIn(w).some((u) => (c.dyn[i] && /^https?:\/\/[^/?#]*[/?#].*[$`]/i.test(u)) || carriesData(u, seen, turn.secrets ?? []))));
}

/** What a shell command line does that is asked about after outside text was read. `depth` stops a script that runs a script that runs the first. */
function shellRisk(command: string, cwd: string, p: Paths, turn: Turn, mode: "posix" | "windows", depth: number): Risk | undefined {
  const view = shellView(command, mode);
  const { cmds } = view;
  const reads = cmds.filter((c) => !/^(echo|printf)$/.test(programName(c.words[0] ?? "")));
  if (reads.some((c) => [...c.words.slice(1), ...c.redirects.filter((r) => r.op.includes("<")).map((r) => r.target)].some(secret))) return risk("secret", "a file that holds secrets is read", "reading secret files after the web was read");
  if (cmds.some((c) => sends(programName(c.words[0] ?? ""), c.words))) return risk("send", "a command sends data over the network", "sending data away after the web was read");
  if (fetchesCarrying(cmds, turn)) return risk("send", "a web address carries data copied from a secret or a file", "sending data away after the web was read");
  if (cmds.some((c) => LATER.test(programName(c.words[0] ?? "")))) return risk("later", "something is set to run later", "scheduling after the web was read");
  if (cmds.some((c) => writes(c).some((t) => away(t, cwd, p)))) return risk("write", "a file outside the project is changed", "changes outside the project after the web was read");
  for (const code of view.code) { const kind = codeRisk(code, cwd, p); if (kind) return CODE[kind](); }
  if (depth > 2) return undefined;
  const made = new Map(cmds.flatMap((c) => (c.stdin === undefined ? [] : c.redirects.filter((r) => /^>>?$/.test(r.op)).map((r): [string, string] => [r.target, c.stdin!]))));
  for (const file of view.files) {
    const text = made.get(file) ?? turn.outside?.script?.(file, cwd);
    if (text === undefined) continue;
    const windows = WINDOWS_FILE.test(file);
    const kind = SHELL_FILE.test(file) || windows ? undefined : codeRisk(text, cwd, p);
    const found = kind ? CODE[kind]() : SHELL_FILE.test(file) || windows ? shellRisk(text, cwd, p, turn, windows ? "windows" : "posix", depth + 1) : undefined;
    if (found) return found;
  }
  return undefined;
}

/**
 * What is asked about once a turn has read text from outside, even where the mode asks for nothing: a page can write instructions, and the
 * actions an instruction would need to do harm without touching the project are the ones named here. Writing inside the project, reading it, running
 * its programs and fetching a page are not in the list: that is the work a person asks for after "read this page". A fetch is asked about only when its
 * address carries data (see `carriesData`), and a program given inline or a script written this turn only when its text does one of the things above.
 * The reason is said to the person.
 */
export function afterOutside(tool: Pick<Tool, "name" | "askAfterOutside">, args: Record<string, unknown>, cwd: string, p: Paths = nativePaths, turn: Turn = {}): Risk | undefined {
  if (tool.askAfterOutside) return risk("later", "something is set to run later", "scheduling after the web was read");
  if (readPaths(tool.name, args).some(secret)) return risk("secret", "a file that holds secrets is read", "reading secret files after the web was read");
  if (changedPaths(tool.name, args).some((f) => away(f, cwd, p))) return risk("write", "a file outside the project is changed", "changes outside the project after the web was read");
  if (tool.name === "WebFetch" && typeof args.url === "string" && carriesData(args.url, seenOf(turn.outside), turn.secrets ?? [])) return risk("send", "a web address carries data copied from a secret or a file", "sending data away after the web was read");
  if (tool.name !== "Bash" || typeof args.command !== "string") return undefined;
  return shellRisk(args.command, cwd, p, turn, "posix", 0);
}
