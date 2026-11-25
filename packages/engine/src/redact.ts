/**
 * Secrets never reach the model, an event or a file the model can read. What counts as one: the value of an environment variable
 * whose name says it is (KEY, TOKEN, SECRET, PASSWORD, …), the keys of the configuration (registered by the engine), and what a key
 * looks like whatever it is called (sk-…, ghp_…, AKIA…, a private key block, a Bearer token). They become "[hidden]".
 */
import { LINK_WORDS, PASSWORD_WORDS } from "./password-words.ts";

const HIDDEN = "[hidden]";
const NAME = /(KEY|TOKEN|SECRET|PASSW(OR)?D|CREDENTIAL|PRIVATE|AUTH)/i;
/** Short values (a flag, a number) are not keys, and a path is not either (SSH_AUTH_SOCK). */
/** Whether a variable's name says it holds a secret. */
export const isSecretName = (name: string): boolean => NAME.test(name);
const worth = (value: string): boolean => value.length >= 8 && !value.startsWith("/") && !/\s/.test(value);

const registered = new Set<string>();
/** Keys the engine knows from its configuration, whatever the environment says. */
export function registerSecrets(values: readonly (string | undefined)[]): void {
  for (const v of values) if (v && worth(v)) registered.add(v);
}

/** Every secret known right now, longest first so that one that holds another is replaced whole. */
export function secretsNow(env: Record<string, string | undefined> = process.env): string[] {
  const found = new Set(registered);
  for (const [name, value] of Object.entries(env)) if (value && NAME.test(name) && worth(value)) found.add(value);
  return [...found].sort((a, b) => b.length - a.length);
}

const SHAPES = /(?<![A-Za-z0-9])(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|xox[abprs]-[A-Za-z0-9-]{10,}|Bearer\s+[A-Za-z0-9._~+/-]{20,}=*)/g;
const KEY_BEGIN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;
const KEY_END = /-----END [A-Z0-9 ]*PRIVATE KEY-----/;
/** Longer than any end marker, so one cut between two pieces is still seen whole. */
const MARKER_TAIL = 48;
/** The start of something that may become a key: a text that ends in it is held back until what follows shows what it is. */
const UNFINISHED = /(?<![A-Za-z0-9])(?:sk-|gh[pousr]_|github_pat_|AKIA|AIza|xox[abprs]-|Bearer\s+|-----BEGIN[ A-Z0-9-]*)[A-Za-z0-9._~+/=-]{0,400}$|-{1,4}$/;

/** What the keys that have a shape start with. */
const STARTERS = ["sk-", "ghp_", "ghu_", "gho_", "ghs_", "ghr_", "github_pat_", "AKIA", "AIza", "xoxa-", "xoxb-", "xoxp-", "xoxr-", "xoxs-", "Bearer ", "-----BEGIN "];

/** How much of the end of `text` is the beginning of one of those, cut short (a piece that ends in "s" or "sk" may be followed by "k-…"): that much is held back too. */
function startedTail(text: string): number {
  let most = 0;
  for (const start of STARTERS) {
    for (let n = Math.min(start.length - 1, text.length); n > most; n--) {
      if (text.endsWith(start.slice(0, n)) && !/[A-Za-z0-9]/.test(text[text.length - n - 1] ?? "")) { most = n; break; }
    }
  }
  return most;
}

/** One text, whole. */
export function redact(text: string, secrets: readonly string[] = secretsNow()): string {
  const r = new Redactor(secrets);
  return r.push(text) + r.end();
}

/** Whether the text holds a secret: a key of the configuration, the value of a secret variable, or something shaped like a key. */
export const holdsSecret = (text: string): boolean => redact(text) !== text;

/**
 * A stream of text, made safe as it arrives. A secret that comes in two pieces is still found: what could be the start of one is held
 * back until the next piece shows what it is (or the stream ends). A private key block is hidden to its end, however many pieces.
 */
export class Redactor {
  #held = "";
  #inKey = false;
  constructor(private readonly secrets: readonly string[] = secretsNow()) {}

  #clean(text: string): string {
    let out = text;
    for (const s of this.secrets) out = out.split(s).join(HIDDEN);
    return out.replace(SHAPES, HIDDEN);
  }

  /**
   * The longest end of `text` that could be the start of a secret. A secret that is whole inside the text is never cut by it: when the
   * held end would begin in the middle of one (a long secret that happens to start like the end of a short one, a key that ends in the
   * first letter of another), it grows to take that one in, so every secret is seen whole by `#clean` or by the next push.
   */
  #undecided(text: string): number {
    let hold = Math.max(UNFINISHED.exec(text)?.[0].length ?? 0, startedTail(text));
    for (const s of this.secrets) {
      for (let n = Math.min(s.length - 1, text.length); n > hold; n--) if (text.endsWith(s.slice(0, n))) { hold = n; break; }
    }
    for (let grown = true; grown && hold < text.length;) {
      grown = false;
      const start = text.length - hold;
      for (const s of this.secrets) {
        for (let at = text.indexOf(s); at >= 0; at = text.indexOf(s, at + 1)) {
          if (at < start && at + s.length > start) { hold = text.length - at; grown = true; break; }
          if (at >= start) break;
        }
        if (grown) break;
      }
      if (grown) continue;
      for (const m of text.matchAll(SHAPES)) if (m.index < start && m.index + m[0].length > start) { hold = text.length - m.index; grown = true; break; }
    }
    return hold;
  }

  push(chunk: string): string {
    let text = this.#held + chunk;
    this.#held = "";
    let out = "";
    for (;;) {
      if (this.#inKey) {
        const end = KEY_END.exec(text);
        // All of it is the key. Only the last of it is kept, in case the end marker is cut between two pieces.
        if (!end) { this.#held = text.slice(-MARKER_TAIL); return out; }
        text = text.slice(end.index + end[0].length);
        this.#inKey = false;
      }
      const begin = KEY_BEGIN.exec(text);
      if (!begin) break;
      out += `${this.#clean(text.slice(0, begin.index))}${HIDDEN}`;
      text = text.slice(begin.index + begin[0].length);
      this.#inKey = true;
    }
    const hold = this.#undecided(text);
    this.#held = hold ? text.slice(text.length - hold) : "";
    return out + this.#clean(hold ? text.slice(0, text.length - hold) : text);
  }

  /** What is still held, now that nothing more will come. */
  end(): string {
    const rest = this.#inKey ? "" : this.#clean(this.#held);
    this.#held = "";
    return rest;
  }
}

const PEM = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g;
/** `API_KEY=…`, `export DB_PASSWORD="…"`, `"apiKey": "…"`: a name that says secret, then a value of one word. A line may start with the number Read gives it or the `file:line:` Grep gives it. */
const ASSIGNED = /^((?:\s*\d+\t|[^\s:]+:\d+:)?\s*(?:export\s+)?["']?[A-Za-z_][\w.-]*?(?:KEY|TOKEN|SECRET|PASSW(?:OR)?D|CREDENTIAL|PRIVATE|AUTH)[\w.-]*["']?\s*[=:]\s*)(["']?)([^\s"'#,]{8,})\2/gim;
const MARK = /\[hidden:(\d+)\]/g;

/** A value that is plainly not a secret: an address, a path, a call, an identifier. */
const ordinary = (v: string): boolean => /:\/\/|^[./~]|[()<>{}[\]$]/.test(v) || /^[a-z_]+$/.test(v);

const escaped = (w: string): string => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+");
const longestFirst = (words: readonly string[]): string[] => [...words].sort((x, y) => y.length - x.length);
/** A value after a word that says it is a password, in any of the languages of `PASSWORD_WORDS`, as a person writes it in a message ("my password is Zx9!kQ7m"). Not a word of the language: it holds a digit, a symbol or both cases. */
const SPOKEN = new RegExp(`(?<![\\p{L}\\p{N}])(?:${longestFirst(Object.values(PASSWORD_WORDS).flat()).map(escaped).join("|")})\\s*(?:(?:${longestFirst(LINK_WORDS).map(escaped).join("|")})\\s*)?["'\`]?([^\\s"'\`,;]{6,})`, "giu");
const looksChosen = (v: string): boolean => /[0-9]|[^A-Za-z]/.test(v) || (/[a-z]/.test(v) && /[A-Z]/.test(v));

/** The secrets in a text a person wrote: what a key looks like, what is assigned to a name that says secret, and a password said in words. */
export function secretsIn(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(PEM)) found.add(m[0]);
  for (const m of text.matchAll(SHAPES)) found.add(m[0]);
  for (const m of text.matchAll(ASSIGNED)) if (!ordinary(m[3]!)) found.add(m[3]!);
  // A sentence's full stop or a closing bracket after the value is not known to belong to it: the value is taken both ways.
  for (const m of text.matchAll(SPOKEN)) if (looksChosen(m[1]!)) { found.add(m[1]!); const bare = m[1]!.replace(/[.!?:)\]]+$/, ""); if (bare !== m[1] && looksChosen(bare)) found.add(bare); }
  return [...found].filter((v) => v.length >= 6);
}

/**
 * The one step a conversation's text passes before it leaves the live engine (the search index, the meaning index and its embeddings server, a summary,
 * a copy, a transfer, a hand-over, the relay, the cloud): keys and shapes of keys, what `known` says, and a password the person said in words become `[hidden]`.
 * The person's own journal keeps what they typed; nothing else does.
 */
export function hideSecrets(text: string, known: readonly string[] = []): string {
  let safe = redact(text);
  for (const v of [...secretsIn(safe), ...known]) if (v) safe = safe.split(v).join("[hidden]");
  return safe;
}

/** A whole conversation through that step: a password said in one message is hidden in every message that holds the same value. */
export function hideInItems<T extends { text: string }>(items: readonly T[]): T[] {
  const known = [...new Set(items.flatMap((i) => secretsIn(i.text)))].sort((a, b) => b.length - a.length);
  return items.map((i) => { const text = hideSecrets(i.text, known); return text === i.text ? i : { ...i, text }; });
}

export interface Hidden { text: string; /** How many values were put out of sight. */ count: number }

/**
 * The secrets of a file or a command, made safe to show and to keep. Each secret becomes a mark, `[hidden:3]`, the same mark each time it
 * is met in this conversation, and the conversation holds only the marks. The value stays here, in memory, so that Edit and Write can
 * put it back when the model writes the mark: a file is changed around its secrets and never given a placeholder as a value.
 */
export class Vault {
  readonly #ids = new Map<string, number>();
  readonly #values: string[] = [];

  #mark(value: string): string {
    let id = this.#ids.get(value);
    if (id === undefined) { id = this.#values.push(value); this.#ids.set(value, id); }
    return `[hidden:${id}]`;
  }

  hide(text: string, secrets: readonly string[] = secretsNow()): Hidden {
    let count = 0;
    const take = (value: string): string => { count++; return this.#mark(value); };
    let out = text;
    for (const s of secrets) {
      const parts = out.split(s);
      if (parts.length > 1) { count += parts.length - 1; out = parts.join(this.#mark(s)); }
    }
    out = out.replace(PEM, (m) => take(m)).replace(SHAPES, (m) => take(m));
    out = out.replace(ASSIGNED, (all, head: string, quote: string, value: string) => (ordinary(value) || /\[hidden:\d+\]/.test(value) ? all : `${head}${quote}${take(value)}${quote}`));
    return { text: out, count };
  }

  /** The values behind the marks in `text`, and the marks this conversation does not know (it was reloaded) and the plain `[hidden]`. */
  restore(text: string): { text: string; unknown: string[] } {
    const unknown: string[] = [];
    const out = text.replace(MARK, (m, n: string) => this.#values[Number(n) - 1] ?? (unknown.push(m), m));
    if (/\[hidden\](?!:)/.test(out)) unknown.push("[hidden]");
    return { text: out, unknown };
  }
}
