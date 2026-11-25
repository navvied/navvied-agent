/**
 * Whether a web address, after text from outside was read, carries data the page cannot know: a plain GET to an address a page named can still leave with
 * a secret in its path or query string. An address the person typed or the page itself holds, as written, is not looked at: it cannot carry what the
 * agent added. The host is not looked at either (a host the page names is what a fetch is for; this computer's own address is no exception, since a collector can run there too).
 */
export interface Seen {
  /** Whether the person's words or the outside text of this turn hold this text. */
  mentions(text: string): boolean;
  /** Whether one of these holds a long run copied from a file read this turn. */
  fromFiles(parts: string[]): boolean;
  /** Whether a file read this turn holds this value. */
  inFiles(value: string): boolean;
}

const MARK = /\[hidden(?::\d+)?\]/;
const HEX = /^[0-9a-f]{32,}$/i;
const LONG_VALUE = 200;
const decode = (s: string): string => { try { return decodeURIComponent(s.replace(/\+/g, " ")); } catch { return s; } };

/** A long run that looks like encoded data: hex, or base64 with both cases and digits. */
const blob = (t: string): boolean => HEX.test(t) || (t.length >= 40 && /^[A-Za-z0-9+/=_-]+$/.test(t) && /[a-z]/.test(t) && /[A-Z]/.test(t) && /\d/.test(t));

/** The addresses in a text, as written. */
export const urlsIn = (text: string): string[] => text.match(/https?:\/\/[^\s'"<>`]+/gi) ?? [];

export function carriesData(raw: string, seen: Seen, secrets: readonly string[]): boolean {
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (seen.mentions(raw) || seen.mentions(raw.replaceAll("&", "&amp;"))) return false;
  const values = [...u.searchParams.entries()].flatMap(([k, v]) => [k, v]);
  const parts = [decode(u.pathname), ...values].filter((x) => x);
  if (parts.some((x) => MARK.test(x))) return true;
  if (secrets.some((s) => s.length >= 6 && parts.some((x) => x.includes(s)))) return true;
  if (seen.fromFiles(parts)) return true;
  const queried = [...u.searchParams.values()];
  if (queried.some((v) => v.length >= 12 && /\d/.test(v) && /[a-z]/i.test(v) && /^[\w+/=.-]+$/.test(v) && seen.inFiles(v))) return true;
  return queried.some((v) => v.length >= LONG_VALUE || v.split(/[^A-Za-z0-9+/=_-]+/).some(blob));
}
