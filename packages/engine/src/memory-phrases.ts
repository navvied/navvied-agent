/** Reads a statement of a lasting fact in any language of `memory-words.ts`: the patterns are built from that data, once, when first needed. */
import { MEMORY_WORDS, type Phrases } from "./memory-words.ts";
import type { Scope } from "./memory.ts";

const escaped = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const LETTER = "\\p{L}\\p{M}\\p{N}";

/** One way to say a thing in one language: `gaps` is whether it leaves room for a clause before or inside it (`…`). */
interface Way { re: RegExp; gaps: boolean }

/** The phrases of one list as patterns, the longest first so "never use" wins over "never". */
function waysOf(list: readonly string[], language: Phrases, anywhere: boolean): Way[] {
  const dense = language.dense === true;
  const polite = [...(language.polite ?? [])].sort((a, b) => b.length - a.length).map(escaped);
  const before = anywhere ? (dense ? "" : `(?<![${LETTER}])`) : `^${polite.length ? `(?:(?:${polite.join("|")})[,:]?\\s*)?` : ""}`;
  return [...list].sort((a, b) => b.length - a.length).map((phrase) => {
    const parts = phrase.split("…").map((p) => escaped(p.trim()).replace(/ /g, dense ? "" : ",?\\s+"));
    return { re: new RegExp(`${before}${parts.join("(.{1,80}?)")}${dense ? "" : `(?![${LETTER}])`}`, "iu"), gaps: parts.length > 1 };
  });
}

interface Compiled { language: Phrases; name: Way[]; now: Way[]; remember: Way[]; rule: Way[]; we: Way[]; prefer: Way[] }
let compiled: Compiled[] | undefined;
const languages = (): Compiled[] => (compiled ??= Object.values(MEMORY_WORDS).map((language) => ({
  language,
  name: waysOf(language.name, language, true),
  now: waysOf(language.now, language, false),
  remember: waysOf(language.remember, language, false),
  rule: waysOf(language.rule, language, false),
  we: waysOf(language.we, language, false),
  prefer: waysOf(language.prefer, language, false),
})));

/** What a sentence says after a phrase (or inside it, for a phrase with a gap), when that is at least `min` characters. */
function clauseOf(sentence: string, ways: readonly Way[], min: number): string | undefined {
  for (const way of ways) {
    const m = way.re.exec(sentence);
    if (!m) continue;
    const clause = (way.gaps ? m.slice(1).join(" ") : sentence.slice(m.index + m[0].length).replace(/^[,:\s]+/, "")).replace(/\s+/g, " ").trim();
    if (clause.length >= min) return clause;
  }
  return undefined;
}

function nameOf(sentence: string, c: Compiled): string | undefined {
  const { language } = c;
  const ends = language.nameEnd ?? [];
  const shape = language.dense ? /^(?![你他她它])[\p{L}\p{M}]{1,8}/u : language.caseless ? /^[\p{L}\p{M}]+(?: [\p{L}\p{M}]+)?/u : /^\p{Lu}[\p{L}\p{M}'-]*(?: \p{Lu}[\p{L}\p{M}'-]*){0,2}/u;
  for (const way of c.name) {
    const m = way.re.exec(sentence);
    if (!m) continue;
    let name = shape.exec(sentence.slice(m.index + m[0].length).replace(/^[,:\s]+/, ""))?.[0];
    for (const end of ends) if (name?.endsWith(end)) name = name.slice(0, -end.length).trim();
    if (name && !ends.includes(name) && name.length >= (language.dense ? 1 : 2)) return name;
  }
  return undefined;
}

/** The note a sentence in a language other than English makes, and who it is for, or nothing. */
export function byPhrases(sentence: string): { scope: Scope; text: string } | undefined {
  for (const c of languages()) {
    const dense = c.language.dense === true;
    const name = nameOf(sentence, c);
    if (name) return { scope: "user", text: `The person's name is ${name}` };
    const clause = clauseOf(sentence, c.now, dense ? 2 : 6) ?? clauseOf(sentence, c.remember, dense ? 2 : 6);
    if (clause) return { scope: "project", text: clause };
    if (clauseOf(sentence, c.rule, dense ? 1 : 6) !== undefined || clauseOf(sentence, c.we, dense ? 1 : 3) !== undefined) return { scope: "project", text: sentence };
    if (clauseOf(sentence, c.prefer, dense ? 1 : 5) !== undefined) return { scope: "user", text: sentence };
  }
  return undefined;
}

/** The end of a sentence cleared of one list of filler, as a pattern. */
const endOf = (words: readonly string[], dense: boolean): RegExp | undefined => {
  if (!words.length) return undefined;
  const any = [...words].sort((a, b) => b.length - a.length).map((w) => escaped(w).replace(/ /g, dense ? "" : "\\s+")).join("|");
  const before = dense ? "" : `(?<![${LETTER}])`, after = dense ? "" : `(?![${LETTER}])`;
  return new RegExp(`(?:[\\s,:;]*${before}(?:${any})${after})+[\\s.!]*$`, "iu");
};
const ends = new WeakMap<readonly string[], RegExp[]>();

/**
 * A note without the words at its end that carry no fact ("… keep that in mind", "… please", "… thanks"): `english` is the English list, the other
 * languages are read from the data. Done on the note, after the statement was recognised, because a closing "remember this" is also what makes a sentence a statement.
 */
export function withoutFiller(note: string, english: readonly string[]): string {
  let patterns = ends.get(english);
  if (!patterns) { patterns = [endOf(english, false), ...Object.values(MEMORY_WORDS).map((l) => endOf(l.filler, l.dense === true))].filter((e): e is RegExp => e !== undefined); ends.set(english, patterns); }
  let out = note.trim();
  for (let again = true; again;) {
    again = false;
    for (const e of patterns) { const next = out.replace(e, "").trim(); if (next && next !== out) { out = next; again = true; } }
  }
  return out;
}
