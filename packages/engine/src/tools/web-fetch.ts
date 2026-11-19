import type { Tool } from "../types.ts";
import { isPrivateHost } from "./hosts.ts";
import { clip, str } from "./util.ts";
import { viaProxy } from "./web-proxy.ts";

export { isPrivateHost };

const readable = (html: string) =>
  html.replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();

const redirected = (status: number, location: string | null): string => `Redirected (${status}) to ${location ?? "an unknown location"}. Fetch that address if it is the one you want.`;

const answer = (status: number, type: string, body: string): string => {
  const text = body.slice(0, 400_000);
  return clip(`${status} ${type}\n${/html/i.test(type) ? readable(text) : text}`);
};

export const webFetch: Tool = {
  name: "WebFetch",
  readOnly: true,
  offeredWhen: ({ userText, chat }) => chat === true || /https?:\/\/|\b(website|web ?page|url|documentation|docs)\b/i.test(userText),
  description: "Fetch a web page or file over http(s); HTML comes back as text.",
  parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  title: (a) => `Fetch ${str(a.url)}`,
  async run(a, ctx) {
    let url: URL;
    try { url = new URL(str(a.url)); } catch { return "Error: that is not a valid URL."; }
    if (url.protocol !== "http:" && url.protocol !== "https:") return "Error: only http(s) URLs can be fetched.";
    if (!ctx.allowPrivateNetwork && isPrivateHost(url.hostname)) return "Error: fetching local or private network addresses is not allowed.";
    if (ctx.webProxy) {
      const got = await viaProxy<{ status: number; contentType?: string; text?: string; redirect?: string }>(ctx.webProxy, "fetch", { url: url.href }, AbortSignal.any([ctx.signal, AbortSignal.timeout(20_000)]));
      if (!got.ok) return `Error: ${got.message}`;
      const { status, contentType = "", text = "", redirect } = got.value;
      if (status >= 300 && status < 400) return redirected(status, redirect ?? null);
      return answer(status, contentType, text);
    }
    const res = await fetch(url, { signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(20_000)]), redirect: "manual", headers: { "user-agent": "navvied-agent" } }).catch((e: Error) => e);
    if (res instanceof Error) return `Error: ${res.message}`;
    if (res.status >= 300 && res.status < 400) return redirected(res.status, res.headers.get("location"));
    return answer(res.status, res.headers.get("content-type") ?? "", await res.text());
  },
};
