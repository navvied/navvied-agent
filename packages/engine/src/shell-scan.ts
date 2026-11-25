/**
 * What a shell command line really runs. The words of every command are decoded the way a shell decodes them (quotes, backslashes,
 * `$'..'`, variables set earlier in the same line), the commands inside substitutions, `eval`, `sh -c` payloads and heredocs fed to a
 * shell are found, and the programs that only start another one (sudo, env, timeout, xargs…) are looked through. What cannot be known
 * before it runs (a command whose name is built from something unknown, text too big to read) is reported, never taken as safe.
 */

export interface Redirect { op: string; target: string }
/** One command that will run, as a shell would run it. `fed`: its arguments come from another command (xargs, find). */
export interface Flat { words: string[]; dyn: boolean[]; redirects: Redirect[]; fed?: "xargs" | "find"; sudo: boolean; stdin?: string }
export interface Finding { key: string; reason: string; phrase: string }
export interface View { cmds: Flat[]; found: Finding[] }
export type Mode = "posix" | "windows";

const MAX_CHARS = 100_000, MAX_STEPS = 300_000, MAX_COMMANDS = 600, MAX_DEPTH = 8;

const find = (key: string, reason: string, phrase: string): Finding => ({ key, reason, phrase });
const TOO_BIG = find("unscannable", "This command is too long or too tangled to be checked before it runs.", "commands that cannot be checked");
const DYNAMIC = find("dynamic-command", "This runs a program whose name is only known while it runs, so it cannot be checked first.", "commands whose name is built while they run");
const BUILT = find("built-command", "This runs text that is put together while it runs, so it cannot be checked first.", "commands built while they run");
const FETCHED = find("pipe-to-shell", "This runs a program that was just downloaded, without looking at it first.", "running downloaded programs");
const DECODED = find("decoded-to-shell", "This runs text that was decoded a moment before, so nobody can read it first.", "running decoded text");

interface W { t: string; dyn: boolean }
interface Raw { words: W[]; redirects: Redirect[]; pipeIn?: Raw; heredoc?: string }

const KEYWORDS = new Set(["if", "then", "else", "elif", "fi", "do", "done", "while", "until", "!", "{", "}", "esac", "function"]);
const SKIPPED = new Set(["for", "select", "case"]);
const ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r", a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", v: "\v", "\\": "\\", "'": "'", '"': '"', "?": "?" };

/** The text of a `$'…'` string with its escapes decoded; `i` points after the opening quote. */
function ansiC(src: string, i: number): { text: string; end: number } {
  let t = "";
  while (i < src.length && src[i] !== "'") {
    const c = src[i]!;
    if (c !== "\\") { t += c; i++; continue; }
    const n = src[i + 1] ?? "";
    const hex = /^x([0-9a-fA-F]{1,2})/.exec(src.slice(i + 1, i + 4)) ?? /^u([0-9a-fA-F]{1,4})/.exec(src.slice(i + 1, i + 6)) ?? /^U([0-9a-fA-F]{1,8})/.exec(src.slice(i + 1, i + 10));
    const oct = /^[0-7]{1,3}/.exec(src.slice(i + 1, i + 4));
    if (hex) { try { t += String.fromCodePoint(parseInt(hex[1]!, 16)); } catch { /* not a character */ } i += 1 + hex[0].length; }
    else if (oct) { t += String.fromCharCode(parseInt(oct[0], 8)); i += 1 + oct[0].length; }
    else if (n in ESCAPES) { t += ESCAPES[n]; i += 2; }
    else { t += n; i += 2; }
  }
  return { text: t, end: i + 1 };
}

class Parser {
  raws: Raw[] = [];
  bad = false;
  #src: string;
  #i = 0;
  #steps = 0;
  readonly #vars = new Map<string, string>();
  #lastEnd = -1;
  #close: string | undefined;
  #heredocs: { raw: Raw; delim: string; strip: boolean; quoted: boolean }[] = [];

  constructor(src: string, private readonly mode: Mode, private readonly shared?: Parser) {
    this.#src = src;
    if (shared) this.#vars = shared.#vars;
  }

  run(): void { this.#list(undefined, 0); }

  #tick(): boolean { if (++this.#steps > MAX_STEPS || this.raws.length > MAX_COMMANDS) { this.bad = true; this.#i = this.#src.length; return false; } return true; }

  #list(close: string | undefined, depth: number): void {
    if (depth > MAX_DEPTH) { this.bad = true; this.#i = this.#src.length; return; }
    const s = this.#src, outer = this.#close;
    this.#close = close;
    let cmd: Raw = { words: [], redirects: [] }, last: Raw | undefined, skipping = false, assigns: [string, W][] = [];
    const flush = (pipe: boolean): void => {
      if (cmd.words.length || cmd.redirects.length) { this.raws.push(cmd); last = cmd; }
      else if (assigns.length) { for (const [name, w] of assigns) { if (w.dyn) this.#vars.delete(name); else this.#vars.set(name, w.t); } last = undefined; }
      else if (!pipe) last = undefined;
      if (cmd.words.length || cmd.redirects.length) for (const [name, w] of assigns) if (cmd.words[0]?.t === "export") { if (w.dyn) this.#vars.delete(name); else this.#vars.set(name, w.t); }
      cmd = { words: [], redirects: [], ...(pipe && last ? { pipeIn: last } : {}) };
      assigns = []; skipping = false;
    };
    let parens = 0;
    while (this.#i < s.length) {
      if (!this.#tick()) return;
      const c = s[this.#i]!;
      if (close && c === close && parens === 0) { this.#i++; break; }
      if (c === "\n") { this.#i++; this.#readHeredocs(); flush(false); continue; }
      if (c === " " || c === "\t" || c === "\r") { this.#i++; continue; }
      if (c === "#" && (this.#i === 0 || /[\s;&|(]/.test(s[this.#i - 1]!))) { while (this.#i < s.length && s[this.#i] !== "\n") this.#i++; continue; }
      if (c === ";") { this.#i++; flush(false); continue; }
      if (c === "&" && s[this.#i + 1] !== ">") { this.#i += s[this.#i + 1] === "&" ? 2 : 1; flush(false); continue; }
      if (c === "|") { const pipe = s[this.#i + 1] !== "|"; this.#i += s[this.#i + 1] === "|" || s[this.#i + 1] === "&" ? 2 : 1; flush(pipe); continue; }
      if (c === "(" && !(this.#i > 0 && s[this.#i - 1] === "$")) { parens++; this.#i++; flush(false); continue; }
      if (c === ")") { this.#i++; if (parens > 0) parens--; flush(false); continue; }
      if ((c === ">" || c === "<") && s[this.#i + 1] !== "(" || (c === "&" && s[this.#i + 1] === ">")) { this.#redirect(cmd, depth); continue; }
      const w = this.#word(depth);
      if (!w) continue;
      if (cmd.words.length === 0 && !skipping) {
        const assign = /^([A-Za-z_]\w*)\+?=/.exec(w.t);
        if (assign) { assigns.push([assign[1]!, { t: w.t.slice(assign[0].length), dyn: w.dyn || assign[0].includes("+") }]); continue; }
        if (!w.dyn && KEYWORDS.has(w.t)) continue;
        if (!w.dyn && SKIPPED.has(w.t)) { skipping = true; continue; }
      }
      if (skipping) continue;
      if (cmd.words.length && /^[A-Za-z_]\w*=/.test(w.t) && cmd.words[0]!.t === "export") assigns.push([w.t.slice(0, w.t.indexOf("=")), { t: w.t.slice(w.t.indexOf("=") + 1), dyn: w.dyn }]);
      cmd.words.push(w);
    }
    flush(false);
    this.#close = outer;
  }

  #readHeredocs(): void {
    const s = this.#src;
    for (const h of this.#heredocs.splice(0)) {
      const lines: string[] = [];
      while (this.#i < s.length) {
        let end = s.indexOf("\n", this.#i);
        if (end < 0) end = s.length;
        const line = s.slice(this.#i, end).replace(/\r$/, "");
        this.#i = Math.min(end + 1, s.length);
        if ((h.strip ? line.replace(/^\t+/, "") : line) === h.delim) break;
        lines.push(line);
      }
      const body = lines.join("\n");
      h.raw.heredoc = (h.raw.heredoc ?? "") + body;
      if (!h.quoted && /\$\(|`/.test(body)) this.#inside(body, () => this.#quoted(undefined, 0));
    }
  }

  /** Reads `text` in place of the source for a moment (a heredoc body, a string with substitutions in it). */
  #inside(text: string, read: () => void): void {
    const [src, i] = [this.#src, this.#i];
    this.#src = text; this.#i = 0;
    try { read(); } finally { this.#src = src; this.#i = i; }
  }

  #redirect(cmd: Raw, depth: number): void {
    const s = this.#src;
    const op = /^(&>>|&>|>>|>\||>&|>|<<<|<<-|<<|<&|<>|<)/.exec(s.slice(this.#i, this.#i + 4))![1]!;
    const prefix = cmd.words.at(-1);
    if (prefix && /^\d+$/.test(prefix.t) && this.#lastEnd === this.#i) cmd.words.pop();
    this.#i += op.length;
    while (s[this.#i] === " " || s[this.#i] === "\t") this.#i++;
    const from = this.#i;
    const target = this.#word(depth);
    if (!target) return;
    if ((op === ">&" || op === "<&") && /^(\d+|-)$/.test(target.t)) return;
    if (op === "<<" || op === "<<-") {
      const raw = s.slice(from, this.#i);
      this.#heredocs.push({ raw: cmd, delim: target.t, strip: op === "<<-", quoted: /['"\\]/.test(raw) });
    } else if (op === "<<<") cmd.heredoc = (cmd.heredoc ?? "") + target.t;
    else cmd.redirects.push({ op, target: target.t });
  }

  /** A word, with quoting removed and what it is made of worked out. The text keeps `$name` where the value is not known, and `dyn` says so. */
  #word(depth: number): W | undefined {
    const s = this.#src, posix = this.mode === "posix";
    let t = "", dyn = false, any = false;
    while (this.#i < s.length) {
      if (!this.#tick()) return undefined;
      const c = s[this.#i]!, n = s[this.#i + 1];
      if (c === this.#close || c === " " || c === "\t" || c === "\n" || c === "\r" || c === ";" || c === "&" || c === "|" || c === ")" || ((c === "<" || c === ">") && n !== "(") || (c === "(" && s[this.#i - 1] !== "$" && !any)) break;
      any = true;
      if (c === "\\" && posix) { if (n === "\n") { this.#i += 2; continue; } t += n ?? ""; this.#i += 2; continue; }
      if (c === "'") { const end = s.indexOf("'", this.#i + 1); const stop = end < 0 ? s.length : end; t += s.slice(this.#i + 1, stop); this.#i = stop + 1; continue; }
      if (c === '"') { this.#i++; const q = this.#quoted('"', depth); t += q.t; dyn ||= q.dyn; continue; }
      if (c === "`") { this.#i++; this.#list("`", depth + 1); t += "$(…)"; dyn = true; continue; }
      if ((c === "<" || c === ">") && n === "(") { const from = this.#i; this.#i += 2; this.#list(")", depth + 1); t += s.slice(from, this.#i); dyn = true; continue; }
      if (c === "$") {
        if (n === "'" && posix) { const a = ansiC(s, this.#i + 2); t += a.text; this.#i = a.end; continue; }
        if (n === '"') { this.#i += 2; const q = this.#quoted('"', depth); t += q.t; dyn ||= q.dyn; continue; }
        const d = this.#dollar(depth); t += d.t; dyn ||= d.dyn; continue;
      }
      t += c; this.#i++;
    }
    if (!any) { if (this.#i < s.length) this.#i++; return undefined; }
    this.#lastEnd = this.#i;
    return { t, dyn };
  }

  /** What follows a `$`: a substitution (its commands are collected), arithmetic, `${name}` or `$name`. */
  #dollar(depth: number): { t: string; dyn: boolean } {
    const s = this.#src, n = s[this.#i + 1] ?? "";
    if (n === "(" && s[this.#i + 2] === "(") {
      let level = 0, j = this.#i + 1;
      for (; j < s.length; j++) { if (s[j] === "(") level++; else if (s[j] === ")" && --level === 0) break; }
      const t = s.slice(this.#i, j + 1); this.#i = j + 1; return { t, dyn: true };
    }
    if (n === "(") { this.#i += 2; this.#list(")", depth + 1); return { t: "$(…)", dyn: true }; }
    const braced = n === "{";
    const name = braced ? /^\{([A-Za-z_]\w*)\}/.exec(s.slice(this.#i + 1, this.#i + 80))?.[1] : /^[A-Za-z_]\w*/.exec(s.slice(this.#i + 1, this.#i + 80))?.[0];
    if (braced && name === undefined) { const end = s.indexOf("}", this.#i); const t = s.slice(this.#i, end < 0 ? s.length : end + 1); this.#i += t.length; return { t, dyn: true }; }
    if (name === undefined) { const t = /^[@*#?$!0-9-]/.test(n) ? `$${n}` : "$"; this.#i += t.length; return { t, dyn: t.length > 1 }; }
    this.#i += 1 + name.length + (braced ? 2 : 0);
    const value = this.#vars.get(name);
    return value === undefined ? { t: `$${name}`, dyn: true } : { t: value, dyn: false };
  }

  /** Inside double quotes, until `close` (or the end when there is none). */
  #quoted(close: string | undefined, depth: number): { t: string; dyn: boolean } {
    const s = this.#src;
    let t = "", dyn = false;
    while (this.#i < s.length) {
      if (!this.#tick()) break;
      const c = s[this.#i]!, n = s[this.#i + 1] ?? "";
      if (close && c === close) { this.#i++; return { t, dyn }; }
      if (c === "\\" && this.mode === "posix" && "$`\"\\\n".includes(n) && n) { if (n !== "\n") t += n; this.#i += 2; continue; }
      if (c === "`") { this.#i++; this.#list("`", depth + 1); t += "$(…)"; dyn = true; continue; }
      if (c === "$") { const d = this.#dollar(depth); t += d.t; dyn ||= d.dyn; continue; }
      t += c; this.#i++;
    }
    return { t, dyn };
  }
}

/** The programs that start another program, and where the inner command begins (words after the wrapper's own options). */
const WITH_ARG: Record<string, RegExp> = {
  sudo: /^-[ughpCTrtUDR]$/, doas: /^-[uC]$/, env: /^-[uCS]$/, nice: /^-n$/, ionice: /^-[cnp]$/, stdbuf: /^-[ioe]$/, xargs: /^-[IndEeLsPaR]$/, exec: /^-a$/, flock: /^-[wE]$/, watch: /^-n$/, timeout: /^-[sk]$/, chroot: /^$/, pkexec: /^--user$/,
};
const WRAPPERS = new Set(["sudo", "doas", "pkexec", "env", "nohup", "setsid", "timeout", "nice", "ionice", "command", "builtin", "exec", "time", "busybox", "xargs", "stdbuf", "unbuffer", "watch", "flock", "taskset", "chrt"]);
/** The program a command runs, as a plain name (`/bin/rm` and `RM.exe` are `rm`). */
export const programName = (p: string): string => p.replace(/^.*[\\/]/, "").replace(/\.exe$/i, "").toLowerCase();

interface Unwrapped { words: W[]; sudo: boolean; fed: boolean }

/** The command a wrapper runs, or nothing when the first word is not a wrapper (or has nothing inside). */
function unwrapOnce(words: W[]): Unwrapped | undefined {
  const head = words[0];
  if (!head || head.dyn) return undefined;
  const name = programName(head.t);
  if (!WRAPPERS.has(name)) return undefined;
  let i = 1;
  const arg = WITH_ARG[name];
  while (i < words.length) {
    const w = words[i]!.t;
    if (name === "busybox") break;
    if (/^[A-Za-z_]\w*=/.test(w) && name !== "xargs") { i++; continue; }
    if (name === "timeout" && /^\d+(\.\d+)?[smhd]?$/.test(w)) { i++; break; }
    if (name === "taskset" && !w.startsWith("-")) { i++; break; }
    if (name === "flock" && !w.startsWith("-")) { i++; if (words[i]?.t === "-c") return { words: [{ t: "sh", dyn: false }, ...words.slice(i)], sudo: false, fed: false }; break; }
    if (name === "chrt" && /^\d+$/.test(w)) { i++; break; }
    if (!w.startsWith("-") || w === "-") break;
    if (w === "--") { i++; break; }
    if (name === "command" && /^-[vV]/.test(w)) return undefined;
    i += arg?.test(w) ? 2 : 1;
  }
  const inner = words.slice(i);
  if (!inner.length) return undefined;
  return { words: inner, sudo: name === "sudo" || name === "doas" || name === "pkexec", fed: name === "xargs" };
}

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash", "fish", "csh", "tcsh"]);
const SCRIPTERS: Record<string, RegExp> = { python: /^-[A-Za-z]*c$/, python3: /^-[A-Za-z]*c$/, node: /^-[pe]$|^--eval$/, nodejs: /^-e$/, bun: /^-e$|^--eval$/, deno: /^eval$/, perl: /^-[A-Za-z]*[eE]$/, ruby: /^-e$/, php: /^-r$/, lua: /^-e$/ };
const FETCHERS = new Set(["curl", "wget", "fetch", "nc", "ncat", "netcat"]);
const DECODERS = new Set(["base64", "base32", "xxd", "openssl", "gunzip", "zcat", "bzcat", "xzcat", "uudecode", "basenc"]);
const READS_STDIN = /^(sh|bash|zsh|dash|ksh|ash|python\d?(\.\d+)?|node|nodejs|bun|perl|ruby|php)$/;
const EXEC_PRIMITIVE = /\b(os\.system|os\.popen|subprocess|popen|execSync|child_process|spawn|exec|system|Runtime|shell_exec|passthru|IO\.popen)\b|`/;
const DELETE_PRIMITIVE = /\b(rmtree|rm_rf|rm_r|rmSync|rmdirSync|removeSync|remove_tree|unlinkSync|os\.remove|os\.unlink|os\.rmdir|rmdir|unlink|File\.delete|FileUtils)\b/;

const programOf = (w: W): string | undefined => {
  if (!w.dyn) return programName(w.t);
  const tail = w.t.slice(w.t.lastIndexOf("/") + 1);
  return w.t.includes("/") && tail && !/[$(`]/.test(tail) ? programName(tail) : undefined;
};

interface State { cmds: Flat[]; found: Finding[]; mode: Mode; parser: Parser }

const add = (st: State, f: Finding): void => { if (!st.found.some((x) => x.key === f.key)) st.found.push(f); };

/** The command words of a payload, as text. */
function payloadWord(words: W[], flag: RegExp): W | undefined {
  for (let i = 1; i < words.length - 1; i++) { if (flag.test(words[i]!.t)) return words[i + 1]; if (!words[i]!.t.startsWith("-")) break; }
  return undefined;
}

function scanInto(text: string, st: State, depth: number, fed?: Flat["fed"]): void {
  if (depth > MAX_DEPTH) { add(st, TOO_BIG); return; }
  const p = new Parser(text, st.mode, st.parser);
  p.run();
  if (p.bad) add(st, TOO_BIG);
  for (const raw of p.raws) visit(raw, st, depth, fed);
}

/** Text a script program is given with -c / -e: strings in it that look like commands are looked at when it can run commands. */
function scanScript(text: string, st: State, depth: number): void {
  if (text.length > 20_000) { add(st, TOO_BIG); return; }
  if (EXEC_PRIMITIVE.test(text)) for (const m of text.matchAll(/(["'])((?:\\.|(?!\1)[^\\])*)\1/g)) { const lit = m[2]!; if (/[\s/]/.test(lit)) scanInto(lit, st, depth + 1); }
  if (DELETE_PRIMITIVE.test(text)) add(st, find("script-delete", "This runs a few lines of a program that delete files, and what it deletes cannot be checked first.", "programs that delete files"));
}

const unwrapped = (raw: Raw): Unwrapped => {
  let cur: Unwrapped = { words: raw.words, sudo: false, fed: false };
  for (let n = 0; n < 12; n++) { const u = unwrapOnce(cur.words); if (!u) break; cur = { words: u.words, sudo: cur.sudo || u.sudo, fed: cur.fed || u.fed }; }
  return cur;
};

function visit(raw: Raw, st: State, depth: number, fed?: Flat["fed"]): void {
  if (depth > MAX_DEPTH) { add(st, TOO_BIG); return; }
  const u = unwrapped(raw);
  if (!u.words.length) return;
  const words = u.words, head = words[0]!;
  const name = programOf(head);
  const flat: Flat = { words: words.map((w) => w.t), dyn: words.map((w) => w.dyn), redirects: raw.redirects, sudo: u.sudo, ...(u.fed ? { fed: "xargs" as const } : fed ? { fed } : {}), ...(raw.heredoc !== undefined ? { stdin: raw.heredoc } : {}) };
  st.cmds.push(flat);
  if (name === undefined) { add(st, DYNAMIC); return; }
  const fromProducers = (): void => {
    const chain: string[] = [];
    for (let p = raw.pipeIn; p; p = p.pipeIn) { const n = programOf(unwrapped(p).words[0] ?? { t: "", dyn: true }); if (n) chain.push(n); }
    if (chain.some((n) => FETCHERS.has(n))) add(st, FETCHED);
    else if (chain.some((n) => DECODERS.has(n))) add(st, DECODED);
    else if (raw.pipeIn) { const w = unwrapped(raw.pipeIn).words; if (/^(echo|printf)$/.test(programOf(w[0] ?? head) ?? "")) scanInto(w.slice(1).filter((x) => !/^-[neE]+$/.test(x.t)).map((x) => x.t).join(" "), st, depth + 1); }
  };
  const fetching = (): boolean => st.cmds.some((c) => FETCHERS.has(programName(c.words[0] ?? "")));
  if (name === "su") {
    const i = words.findIndex((w) => w.t === "-c" || w.t === "--command");
    if (i > 0 && words[i + 1]) { flat.sudo = true; scanInto(words[i + 1]!.t, st, depth + 1); }
  } else if (SHELLS.has(name)) {
    const c = payloadWord(words, /^-[A-Za-z]*c[A-Za-z]*$/);
    if (c) {
      if (c.dyn) { add(st, fetching() ? FETCHED : BUILT); }
      scanInto(c.t, st, depth + 1, flat.fed);
    } else if (words.some((w) => /^<\(/.test(w.t)) && fetching()) add(st, FETCHED);
    else if (words.length === 1 || words.every((w, i) => i === 0 || w.t.startsWith("-"))) {
      if (raw.heredoc !== undefined) scanInto(raw.heredoc, st, depth + 1);
      fromProducers();
    }
  } else if (READS_STDIN.test(name) && words.length === 1) { if (raw.heredoc !== undefined) scanScript(raw.heredoc, st, depth); fromProducers(); }
  else if (SCRIPTERS[name.replace(/\d+(\.\d+)*$/, "")] ?? SCRIPTERS[name]) {
    const c = payloadWord(words, (SCRIPTERS[name] ?? SCRIPTERS[name.replace(/\d+(\.\d+)*$/, "")])!);
    if (c) scanScript(c.t, st, depth);
  } else if (name === "eval") {
    const text = words.slice(1).map((w) => w.t).join(" ");
    if (words.slice(1).some((w) => w.dyn)) add(st, fetching() ? FETCHED : BUILT);
    scanInto(text, st, depth + 1);
  } else if (name === "source" || name === ".") { if (words.some((w) => /^<\(/.test(w.t)) && fetching()) add(st, FETCHED); }
  else if (name === "cmd") { const i = words.findIndex((w) => /^\/[ck]$/i.test(w.t)); if (i > 0 && words[i + 1]) scanInto(words.slice(i + 1).map((w) => w.t).join(" "), { ...st, mode: "windows" }, depth + 1); }
  else if (name === "powershell" || name === "pwsh") { const i = words.findIndex((w) => /^-c(ommand)?$/i.test(w.t)); if (i > 0 && words[i + 1]) scanInto(words.slice(i + 1).map((w) => w.t).join(" "), { ...st, mode: "windows" }, depth + 1); }
  else if (name === "find") {
    for (let i = 1; i < words.length; i++) {
      if (!/^-(exec|execdir|ok|okdir)$/.test(words[i]!.t)) continue;
      let j = i + 1;
      while (j < words.length && words[j]!.t !== ";" && words[j]!.t !== "+") j++;
      const inner = words.slice(i + 1, j);
      if (inner.length) visit({ words: inner, redirects: [] }, st, depth + 1, "find");
      i = j;
    }
  }
}

/** Everything a command line will run, and what could not be told. Never throws; a line that is too large or too tangled is reported as such. */
export function shellView(command: string, mode: Mode = "posix"): View {
  if (command.length > MAX_CHARS) return { cmds: [], found: [TOO_BIG] };
  const main = new Parser(command, mode);
  const st: State = { cmds: [], found: [], mode, parser: main };
  main.run();
  if (main.bad) add(st, TOO_BIG);
  for (const raw of main.raws) visit(raw, st, 0);
  return { cmds: st.cmds, found: st.found };
}
