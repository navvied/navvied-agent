import { redact } from "../../redact.ts";

/**
 * A login the person gave goes to the site they named and to no other. The site is an exact origin (scheme, host and port); what they
 * named is read from what they wrote (an address, or a plain domain name), and the page is compared with it at the moment of typing.
 */

/** The endings of names that are sites; a file name such as `notes.md` or `main.py` is not one. */
const TLDS = "com|org|net|io|co|id|dev|app|ai|edu|gov|me|us|uk|de|fr|es|it|nl|jp|cn|in|br|au|ca|ru|sg|my|xyz|info|biz|site|online|cloud";
const URLS = /https?:\/\/[^\s<>"'`)\]]+/gi;
const DOMAINS = new RegExp(`(?<![\\w@./:-])((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+(?:${TLDS}))(?::(\\d{1,5}))?(?![\\w-])`, "gi");

export const originOf = (url: string): string | undefined => { try { const o = new URL(url).origin; return o === "null" ? undefined : o; } catch { return undefined; } };

/** The origins a person's message names: addresses as written, and plain domain names as the secure site of that name. */
export function originsIn(text: string): string[] {
  const found = new Set<string>();
  for (const u of text.match(URLS) ?? []) { const o = originOf(u.replace(/[.,;:!?]+$/, "")); if (o) found.add(o); }
  for (const m of text.replace(URLS, " ").matchAll(DOMAINS)) { const o = originOf(`https://${m[1]}${m[2] ? `:${m[2]}` : ""}`); if (o) found.add(o); }
  return [...found];
}

export interface Credentials { secrets: readonly string[]; origins: readonly string[] }

export const holdsSecret = (text: string, c: Credentials | undefined): boolean => !!c && c.secrets.some((s) => s.length >= 6 && text.includes(s));

/** The secrets of the person, hidden in a text the model is about to read. */
export const hideSecrets = (text: string, c: Credentials | undefined): string => (c?.secrets.length ? redact(text, [...c.secrets].sort((a, b) => b.length - a.length)) : text);

/** Why a secret may not be typed on this page, in the words the model passes on, or nothing when the page is one the person named. */
export function whyNotHere(pageOrigin: string | undefined, c: Credentials | undefined): string | undefined {
  const named = c?.origins ?? [];
  if (pageOrigin && named.includes(pageOrigin)) return undefined;
  const where = pageOrigin ?? "an address that is not a site";
  return named.length
    ? `Not typed: this page is ${where}, and the person named ${named.slice(0, 3).join(", ")}. A redirect or a script may have moved the page. Tell the person in one sentence; ask before typing it here.`
    : `Not typed: the person has not named the site this goes to (the page is ${where}). Ask which site it is for.`;
}
