import type { Tool } from "../types.ts";
import { clip, str } from "./util.ts";

/** Loopback, link-local and private ranges — blocked unless the host opts in (an agent must not probe the local network by default). */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (h === "::1" || h === "::" || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h)) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

const readable = (html: string) =>
  html.replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();

export const webFetch: Tool = {
  name: "WebFetch",
  readOnly: true,
  offeredWhen: ({ small, userText }) => !small || /https?:\/\//i.test(userText),
  description: "Fetch a web page or file over http(s) and return its text. HTML is reduced to readable text.",
  parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  title: (a) => `Fetch ${str(a.url)}`,
  async run(a, ctx) {
    let url: URL;
    try { url = new URL(str(a.url)); } catch { return "Error: that is not a valid URL."; }
    if (url.protocol !== "http:" && url.protocol !== "https:") return "Error: only http(s) URLs can be fetched.";
    if (!ctx.allowPrivateNetwork && isPrivateHost(url.hostname)) return "Error: fetching local or private network addresses is not allowed.";
    const res = await fetch(url, { signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(20_000)]), redirect: "manual", headers: { "user-agent": "navvied-agent" } }).catch((e: Error) => e);
    if (res instanceof Error) return `Error: ${res.message}`;
    if (res.status >= 300 && res.status < 400) return `Redirected (${res.status}) to ${res.headers.get("location") ?? "an unknown location"}. Fetch that address if it is the one you want.`;
    const type = res.headers.get("content-type") ?? "";
    let text = (await res.text()).slice(0, 400_000);
    if (/html/i.test(type)) text = readable(text);
    return clip(`${res.status} ${type}\n${text}`);
  },
};
