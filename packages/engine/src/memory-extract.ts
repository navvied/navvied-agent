/**
 * Notes that fill themselves. After a turn that ended well, what the person said in their own words is looked through for lasting
 * facts (a preference, a convention, a name, a decision) and each one is proposed as a note. Two ways, both bounded:
 *  - rules: explicit statements in English ("always use tabs", "my name is …", "we use …"). Free, instant, offline. Other languages
 *    are not covered by the rules; the host may turn on the second way for them.
 *  - model (`memory.extract: model`, off unless the host sets it): one short call to the same provider with the person's words,
 *    secrets already hidden, which answers with the facts, one per line.
 * Neither ever keeps a secret: a sentence that holds a key, or talks about a password or a token, is dropped before anything else.
 */
import { holdsSecret, redact } from "./redact.ts";
import { clean, scanText } from "./text-scan.ts";
import type { Scope } from "./memory.ts";

export interface Proposal { scope: Scope; text: string; /** The message (1-based, among the messages of the conversation) it was taken from; absent for the model's, which read them all. */ n?: number }

/** What a sentence may not talk about to become a note: the value would be a secret, or the note would be about one. */
const SECRET_WORDS = /\b(passw(or)?d|passphrase|passcode|pin code|token|api[ _-]?key|secret|credentials?|private key|ssh key|otp|2fa)\b/i;
const MOST_PER_TURN = 3;
const SENTENCE_MIN = 8;
const SENTENCE_MAX = 200;
/** What the model call is given at most, in characters. */
const MODEL_INPUT = 3_000;

const hasUrlSecret = (s: string): boolean => /[?&](token|key|secret|password)=/i.test(s);

/** Statements the person makes about themselves or the work, with the place the note is for and how it is worded. */
const RULES: readonly { shape: RegExp; scope: Scope; say: (m: RegExpExecArray) => string }[] = [
  { shape: /\b(?:[Mm]y name is|[Cc]all me|[Ii] am called)\s+(\p{Lu}[\p{L}'-]*(?: \p{Lu}[\p{L}'-]*){0,2})/u, scope: "user", say: (m) => `The person's name is ${m[1]}` },
  { shape: /^(?:please\s+)?(?:from now on|going forward|in future),?\s+(.{6,})$/i, scope: "project", say: (m) => m[1]! },
  { shape: /^(?:please\s+)?((?:always|never)\s+.{6,})$/i, scope: "project", say: (m) => m[1]! },
  { shape: /^(?:please\s+)?(don'?t|do not)\s+((?:use|add|edit|touch|commit|run|delete|change)\s+.{3,})$/i, scope: "project", say: (m) => `Do not ${m[2]}` },
  { shape: /\bi (?:prefer|like|want) (?:you to |it if you )?(.{5,})$/i, scope: "user", say: (m) => `The person prefers ${m[1]}` },
  { shape: /^we (use|chose|decided to|decided on|run|deploy with|deploy to|keep)\s+(.{3,})$/i, scope: "project", say: (m) => `We ${m[1]} ${m[2]}` },
  { shape: /^(?:the|our) (?:project|repo|repository|codebase|app|api|server|database|staging server) (?:is called|is named|uses|runs on|lives in|is on)\s+(.{2,})$/i, scope: "project", say: (m) => m[0] },
];

/** One sentence of the person's own words as a text a note may be made from: nothing that is a question, a secret or an instruction to the model. */
function eligible(sentence: string): boolean {
  if (sentence.length < SENTENCE_MIN || sentence.length > SENTENCE_MAX || /[?？]/.test(sentence)) return false;
  if (SECRET_WORDS.test(sentence) || holdsSecret(sentence) || hasUrlSecret(sentence)) return false;
  return scanText(sentence).length === 0;
}

const sentences = (text: string): string[] => text.split(/(?<=[.!;])\s+|\n+/).map((s) => s.trim().replace(/[.!\s]+$/, "")).filter(Boolean);

/** Lasting facts the person stated outright in these messages, by the rules. At most a few per turn, in the order said. */
export function extractByRules(messages: readonly { n: number; text: string }[]): Proposal[] {
  const found: Proposal[] = [];
  for (const { n, text: message } of messages) {
    for (const sentence of sentences(message)) {
      if (!eligible(sentence)) continue;
      for (const rule of RULES) {
        const m = rule.shape.exec(sentence);
        if (!m) continue;
        const text = clean(rule.say(m).replace(/\s+/g, " ").trim());
        if (text.length >= SENTENCE_MIN && !found.some((f) => f.text.toLowerCase() === text.toLowerCase())) found.push({ scope: rule.scope, text: text.charAt(0).toUpperCase() + text.slice(1), n });
        break;
      }
    }
  }
  return found.slice(0, MOST_PER_TURN);
}

const ASK = "Read what the person said. Reply with the lasting facts about the person or their project that they stated (a preference, a convention, a name, a decision), one per line as `project: fact` or `user: fact` (user: true for every project). Skip task details, questions, secrets and anything not stated. Reply `none` when there is nothing.";

/** What one call to the model is given: the person's words, secrets hidden, cut to a fixed size. */
export const extractInput = (messages: readonly string[]): string => redact(messages.join("\n---\n")).slice(-MODEL_INPUT);

/** Facts the model found, from its reply: each line is checked the same way a sentence of the rules is, and a reply that does not follow the form gives nothing. */
export function parseProposals(reply: string): Proposal[] {
  const found: Proposal[] = [];
  for (const line of reply.split("\n")) {
    const m = /^\s*[-*]?\s*(project|user)\s*:\s*(.{8,})$/i.exec(line);
    if (!m) continue;
    const raw = m[2]!.replace(/\s+/g, " ").trim(), text = clean(raw);
    if (eligible(raw)) found.push({ scope: m[1]!.toLowerCase() as Scope, text });
  }
  return found.slice(0, MOST_PER_TURN);
}

/** One bounded call through the host's own provider. A failure or a slow answer gives nothing: the notes are a convenience. */
export async function extractByModel(complete: (system: string, user: string, signal: AbortSignal) => Promise<string>, messages: readonly string[], ms = 20_000): Promise<Proposal[]> {
  const input = extractInput(messages);
  if (!input.trim()) return [];
  try { return parseProposals(await complete(ASK, input, AbortSignal.timeout(ms))); } catch { return []; }
}
