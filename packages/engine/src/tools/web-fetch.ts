import { USER_AGENT } from "./user-agent.ts";
import { unreachedSentence, whyUnreached } from "./web-errors.ts";
import type { Tool, ToolContext } from "../types.ts";
import { pdfPages } from "./documents.ts";
import { isPrivateHost } from "./hosts.ts";
import { num, outputBudget, str } from "./util.ts";
import { pages, type Page } from "./web-cache.ts";
import { refusal, vet, web } from "./web-guard.ts";
import { decodeBody } from "./web-charset.ts";
import { fixFetchArgs } from "./web-names.ts";
import { htmlToText, linkLines } from "./web-text.ts";
import { viaProxy } from "./web-proxy.ts";

export { isPrivateHost };

const TIMEOUT_MS = 20_000;
const HOPS = 5;
const MOST_TEXT = 5_000_000;
const MOST_PDF = 15_000_000;
const ACCEPT = "text/markdown, text/html;q=0.9, text/plain;q=0.8, */*;q=0.1";

/** A GitHub page of a file is read from its raw form: the page around the file is not what is wanted. */
function rawGithub(url: URL): URL {
  const m = /^\/([^/]+)\/([^/]+)\/blob\/(.+)$/.exec(url.pathname);
  return url.hostname === "github.com" && m ? new URL(`https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}${url.search}`) : url;
}

const call = (name: string, args: object): string => `${name} ${JSON.stringify(args)}`;
const searchFor = (url: URL): string => call("WebSearch", { query: `${url.hostname} ${url.pathname.split("/").filter(Boolean).slice(-2).join(" ").replace(/[-_.]+/g, " ")}`.trim() });
const browserFor = (url: URL): string => call("Browser", { action: "open", url: url.href });

/** The bytes of an answer, up to a limit (a page is never read whole into memory past it). */
async function readCapped(res: Response, cap: number): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array(await res.arrayBuffer()).subarray(0, cap);
  const parts: Uint8Array[] = [];
  let size = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    size += value.length;
    if (size >= cap) { await reader.cancel().catch(() => undefined); break; }
  }
  return Buffer.concat(parts).subarray(0, cap);
}

export interface Got { url: URL; status: number; type: string; /** The content-type header as the site wrote it, with its charset. */ header?: string; bytes: Uint8Array; text?: string; moved?: URL }

/** One address, followed over redirects that stay on the host; every hop is checked again. The same walk serves a computer and the server that fetches for a session with no network. */
export async function getPage(first: URL, ctx: Pick<ToolContext, "signal" | "allowPrivateNetwork">): Promise<Got | string> {
  let url = first;
  for (let hop = 0; hop <= HOPS; hop++) {
    const vetted = await vet(url, ctx.allowPrivateNetwork);
    if ("refused" in vetted) return `Error: ${vetted.refused}`;
    let res: Response;
    try { res = await web.fetch(url, { signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(TIMEOUT_MS)]), redirect: "manual", headers: { "user-agent": USER_AGENT, accept: ACCEPT } }, vetted.pin); }
    catch (e) {
      const why = whyUnreached(e);
      return why === "timeout" ? `Error: no answer in ${TIMEOUT_MS / 1000} s. Try again, or another address.` : `Error: ${unreachedSentence(why, "That site")}${why === "tls" ? " Do not try another way around it; say so to the user." : ` ${e instanceof Error ? e.message : String(e)}`}`;
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      let next: URL;
      try { next = new URL(res.headers.get("location")!, url); } catch { return "Error: the site sent the page somewhere that is not an address."; }
      await res.body?.cancel().catch(() => undefined);
      // The same host (and a move to https) is followed; another host is the model's to decide.
      if (next.hostname === url.hostname && (next.protocol === url.protocol || next.protocol === "https:")) { url = next; continue; }
      return { url, status: res.status, type: "", bytes: new Uint8Array(), moved: next };
    }
    const header = res.headers.get("content-type") ?? "";
    const type = header.split(";")[0]!.trim().toLowerCase();
    const bytes = await readCapped(res, /pdf/.test(type) ? MOST_PDF : MOST_TEXT);
    return { url, status: res.status, type, header, bytes };
  }
  return `Error: more than ${HOPS} redirects on ${first.hostname}.`;
}

const isHtml = (type: string, text: string): boolean => /html/.test(type) || (!type && /^\s*(<!doctype html|<html)/i.test(text));
const isText = (type: string): boolean => !type || type.startsWith("text/") || /json|xml|javascript|ecmascript|markdown|yaml|toml|csv|x-sh|x-www-form/.test(type);
const challenge = (text: string): boolean => /just a moment|cf-chl|captcha|are you a human|access denied|enable javascript and cookies/i.test(text.slice(0, 4000));

/** What the page says as text, or the sentence that says why not. */
function convert(got: Got): { title: string; body: string } | string {
  const isPdf = got.type === "application/pdf" || (got.bytes.length > 5 && Buffer.from(got.bytes.subarray(0, 5)).toString("latin1") === "%PDF-");
  if (isPdf) {
    try { return { title: "", body: pdfPages(Buffer.from(got.bytes)).map((p, i) => `--- Page ${i + 1} ---\n${p}`).join("\n\n") }; }
    catch (e) { return `Error: ${e instanceof Error ? e.message : "this PDF could not be read"}.`; }
  }
  if (!isText(got.type)) return `Error: not text (${got.type}); nothing to read.`;
  const text = decodeBody(got.bytes, got.header);
  if (!isHtml(got.type, text)) return { title: "", body: text.trim() };
  const page = htmlToText(text, got.url.href);
  const links = page.links.length ? `\n\n${linkLines(page.links)}` : "";
  const body = page.text + links;
  if (page.text.length < 80 && text.length > 1500) return `Error: this page builds its text with scripts, and almost none came back. Try ${browserFor(got.url)}`;
  return { title: page.title, body };
}

/** A part of the page that ends where a line or a paragraph does. */
function slice(page: Page, offset: number, budget: number): string {
  const total = page.text.length;
  if (offset >= total && total > 0) return `Error: offset ${offset} is past the end: the page has ${total} characters.`;
  let end = Math.min(total, offset + budget);
  if (end < total) {
    const edge = Math.max(page.text.lastIndexOf("\n\n", end), page.text.lastIndexOf("\n", end));
    if (edge > offset + budget * 0.6) end = edge;
  }
  const head = `Page ${page.url}${page.title ? ` "${page.title}"` : ""}`;
  const more = end < total ? `\n[characters ${offset}–${end} of ${total}; the rest: ${call("WebFetch", { url: page.url, offset: end })}]` : "";
  return `${head}\n${page.text.slice(offset, end).trim()}${more}`;
}

function failed(status: number, url: URL, text: string): string | undefined {
  if (status < 400) return undefined;
  if (status === 404 || status === 410) return `Error: not found (${status}). Search for it: ${searchFor(url)}`;
  if (status === 429) return "Error: the site says too many requests (429). Wait, then try once more, or use another address.";
  if (status === 401 || status === 403 || challenge(text)) return `Error: the site refused a plain fetch (${status}). If you have a browser: ${browserFor(url)}`;
  return `Error: the site answered ${status}.`;
}

export const webFetch: Tool = {
  name: "WebFetch",
  readOnly: true,
  fromOutside: true,
  offeredWhen: ({ userText, chat }) => chat === true || /https?:\/\/|\b(website|web ?page|url|documentation|docs)\b/i.test(userText),
  description: "Read a web page or PDF as text. A long page ends with the call that reads on (offset).",
  parameters: { type: "object", properties: { url: { type: "string" }, offset: { type: "number" } }, required: ["url"] },
  fixArgs: fixFetchArgs,
  title: (a) => `Fetch ${str(a.url)}`,
  async run(a, ctx) {
    let asked: URL;
    try { asked = new URL(str(a.url)); } catch { return `Error: that is not a valid URL. Retry: ${call("WebFetch", { url: "https://example.com/page" })}`; }
    const url = rawGithub(asked);
    const offset = Math.max(0, Math.floor(num(a.offset, 0)));
    const budget = Math.max(1_500, outputBudget(ctx.window) - 400);
    const also = Array.isArray(a.also) && a.also.length ? `\n[more addresses were given and not fetched: ${(a.also as unknown[]).slice(0, 5).map(String).join(", ")}; fetch each in its own call]` : "";
    const cached = pages.get(url.href);
    if (cached) { ctx.report?.({ cached: true }); return slice(cached, offset, budget) + also; }

    let got: Got | string;
    if (ctx.webProxy) {
      const no = await refusal(url, ctx.allowPrivateNetwork).catch(() => undefined);
      if (no && /private|only http|key or a token/.test(no)) return `Error: ${no}`;
      const answer = await viaProxy<{ status: number; type?: string; header?: string; bytes?: string; moved?: string }>(ctx.webProxy, "fetch", { url: url.href }, AbortSignal.any([ctx.signal, AbortSignal.timeout(TIMEOUT_MS)]));
      if (!answer.ok) return `Error: ${answer.message}`;
      const { status, type = "", header, bytes = "", moved } = answer.value;
      let to: URL | undefined;
      if (moved) { try { to = new URL(moved, url); } catch { return "Error: the site sent the page somewhere that is not an address."; } }
      got = { url, status, type, ...(header ? { header } : {}), bytes: Buffer.from(bytes, "base64"), ...(to ? { moved: to } : {}) };
    } else got = await getPage(url, ctx);
    if (typeof got === "string") return got;
    if (got.moved) return `Redirected (${got.status}) to ${got.moved.href}, another site. If that is the page you want: ${call("WebFetch", { url: got.moved.href })}`;
    const bad = failed(got.status, got.url, Buffer.from(got.bytes.subarray(0, 4000)).toString("utf8"));
    if (bad) return bad;
    const made = convert(got);
    if (typeof made === "string") return made;
    if (!made.body.trim()) return "Error: the page has no text.";
    const page = pages.set(url.href, { title: made.title, text: made.body });
    return slice(page, offset, budget) + also;
  },
};
