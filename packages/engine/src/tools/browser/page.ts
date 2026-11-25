import { untrusted } from "../untrusted.ts";
import { clip, outputBudget } from "../util.ts";
import type { Tab } from "./tab.ts";

/** The page as the model reads it: framed as text from the web, cut to what one result may be, with the way to read on. */
export function describeReading(reading: string, window: number | undefined, offset = 0): string {
  // The page takes most of what one result may be, as any tool result does.
  const most = Math.max(2_000, Math.round(outputBudget(window) * 0.7));
  const more = reading.length > offset + most ? `\n[characters ${offset}–${offset + most} of ${reading.length}; the rest: Browser {"action": "read", "offset": ${offset + most}}]` : "";
  return untrusted("browser", clip(`${reading.slice(offset, offset + most)}${more}`));
}

/** What is on screen, in words, for a model that cannot be shown the picture. */
export async function describeView(tab: Tab): Promise<string> {
  const v = await tab.eval<{ title: string; url: string; w: number; h: number; y: number; total: number; links: number; buttons: number; fields: number; images: number; alts: string[]; headings: string[]; focus: string }>(`(() => {
    const text = (e) => (e.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 80);
    const n = (s) => document.querySelectorAll(s).length;
    return { title: document.title, url: location.href, w: innerWidth, h: innerHeight, y: Math.round(scrollY), total: document.documentElement.scrollHeight,
      links: n("a[href]"), buttons: n("button, [role=button], input[type=submit], input[type=button]"), fields: n("input:not([type=hidden]):not([type=submit]):not([type=button]), textarea, select"), images: n("img"),
      alts: [...document.images].map((i) => i.alt.trim()).filter(Boolean).slice(0, 5), headings: [...document.querySelectorAll("h1, h2, h3")].map(text).filter(Boolean).slice(0, 8),
      focus: document.activeElement && document.activeElement !== document.body ? document.activeElement.tagName.toLowerCase() : "" };
  })()`);
  return untrusted("browser", [
    `Page: ${v.title || "(no title)"}`, `Address: ${v.url}`,
    `Window: ${v.w} x ${v.h}; scrolled ${v.y} of ${Math.max(0, v.total - v.h)} px`,
    `On the page: ${v.links} links, ${v.buttons} buttons, ${v.fields} fields, ${v.images} pictures${v.alts.length ? ` (${v.alts.map((a) => `"${a}"`).join(", ")})` : ""}`,
    ...(v.headings.length ? [`Headings: ${v.headings.join(" | ")}`] : []),
    ...(v.focus ? [`Focus is on a ${v.focus}`] : []),
  ].join("\n"));
}

const JPEG_BUDGET = 256 * 1024;
const MOST_SIDE = 1568;

/** The width and height of a JPEG, read from its header. */
export function jpegSize(data: string): { width: number; height: number } | undefined {
  const b = Buffer.from(data, "base64");
  for (let i = 2; i + 9 < b.length;) {
    if (b[i] !== 0xff) { i++; continue; }
    const marker = b[i + 1]!;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    i += 2 + b.readUInt16BE(i + 2);
  }
  return undefined;
}

/**
 * A picture of the window (or of one control), as a JPEG that fits what a model is given: no side longer than the model reads without
 * shrinking it, and the quality drops until it is small enough. A picture of the whole window is remembered with its size, because the
 * places the model names in it are counted in its pixels.
 */
export async function shoot(tab: Tab, box?: { x: number; y: number; width: number; height: number }): Promise<{ data: string; bytes: number }> {
  // The browser cuts a region out of the page, counted from the page's corner; a control's box is counted from the window's.
  const view = await tab.eval<{ w: number; h: number; ratio: number; x: number; y: number }>("({ w: innerWidth, h: innerHeight, ratio: devicePixelRatio || 1, x: scrollX, y: scrollY })");
  const region = box ? { x: box.x + view.x, y: box.y + view.y, width: box.width, height: box.height } : { x: view.x, y: view.y, width: view.w, height: view.h };
  const clipTo = { ...region, scale: Math.min(1, MOST_SIDE / (Math.max(region.width, region.height) * view.ratio)) };
  let data = "";
  for (const quality of [70, 45, 25]) {
    data = (await tab.send<{ data: string }>("Page.captureScreenshot", { format: "jpeg", quality, clip: clipTo })).data;
    if (data.length * 0.75 <= JPEG_BUDGET) break;
  }
  const size = box ? undefined : jpegSize(data);
  tab.shot = size ? { ...size, cssWidth: view.w, cssHeight: view.h } : undefined;
  return { data, bytes: Math.round(data.length * 0.75) };
}
