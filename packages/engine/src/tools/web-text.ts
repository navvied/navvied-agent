/**
 * Readable text out of a web page with nothing but the language: no parser, no library. What a person reads stays (the main content,
 * headings, lists, code, tables, the words of links); what only frames a page does not (scripts, styles, navigation, footers, forms,
 * hidden things). Links become `[n]` after their words, with the list of addresses at the end, so a model can follow documentation
 * without inventing an address.
 */

export interface PageText { title: string; text: string; links: string[] }

const MOST_LINKS = 40;

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", copy: "©", reg: "®", laquo: "«", raquo: "»", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", bull: "•", middot: "·", times: "×", rarr: "→", larr: "←" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (all, t: string) => {
    if (t[0] === "#") { try { return String.fromCodePoint(t[1] === "x" || t[1] === "X" ? parseInt(t.slice(2), 16) : parseInt(t.slice(1), 10)); } catch { return ""; } }
    return NAMED[t.toLowerCase()] ?? all;
  });
}

/** Elements dropped with everything inside them. */
const DROPPED = new Set(["script", "style", "noscript", "svg", "template", "iframe", "object", "canvas", "head", "nav", "header", "footer", "aside", "form", "dialog", "select", "button"]);
/** Elements that never have an end tag. */
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const BLOCK = new Set(["p", "div", "section", "article", "main", "ul", "ol", "li", "table", "tr", "blockquote", "pre", "figure", "figcaption", "dl", "dt", "dd", "h1", "h2", "h3", "h4", "h5", "h6", "details", "summary", "address", "fieldset"]);

interface Tag { name: string; end: boolean; selfClosing: boolean; attrs: Record<string, string>; length: number }

/** The tag that starts at `at` (the `<`), or nothing when it is not one. */
function tagAt(html: string, at: number): Tag | undefined {
  const m = /^<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)/.exec(html.slice(at, at + 64));
  if (!m) return undefined;
  let i = at + m[0].length;
  const attrs: Record<string, string> = {};
  for (;;) {
    while (i < html.length && /[\s/]/.test(html[i]!)) i++;
    if (i >= html.length) return { name: m[2]!.toLowerCase(), end: m[1] === "/", selfClosing: false, attrs, length: html.length - at };
    if (html[i] === ">") { i++; break; }
    const name = /^[^\s=>/]+/.exec(html.slice(i, i + 80))?.[0];
    if (!name) { i++; continue; }
    i += name.length;
    while (/\s/.test(html[i] ?? "")) i++;
    let value = "";
    if (html[i] === "=") {
      i++;
      while (/\s/.test(html[i] ?? "")) i++;
      const q = html[i];
      if (q === '"' || q === "'") { const end = html.indexOf(q, i + 1); value = html.slice(i + 1, end < 0 ? undefined : end); i = end < 0 ? html.length : end + 1; }
      else { const v = /^[^\s>]*/.exec(html.slice(i, i + 2000))![0]; value = v; i += v.length; }
    }
    attrs[name.toLowerCase()] = decodeEntities(value);
  }
  return { name: m[2]!.toLowerCase(), end: m[1] === "/", selfClosing: html[i - 2] === "/", attrs, length: i - at };
}

const hidden = (t: Tag): boolean => "hidden" in t.attrs || t.attrs["aria-hidden"] === "true" || /display\s*:\s*none|visibility\s*:\s*hidden/i.test(t.attrs.style ?? "");

/** The inside of the first element named one of `names`, found by counting nested ones of the same name. */
function inside(html: string, names: string[]): string | undefined {
  for (const name of names) {
    const open = new RegExp(`<${name}(?=[\\s>/])`, "i");
    const start = open.exec(html);
    if (!start) continue;
    const first = tagAt(html, start.index);
    if (!first) continue;
    let depth = 1, i = start.index + first.length;
    const any = new RegExp(`<(/?)${name}(?=[\\s>/])`, "gi");
    any.lastIndex = i;
    for (let m = any.exec(html); m; m = any.exec(html)) {
      depth += m[1] ? -1 : 1;
      if (depth === 0) return html.slice(i, m.index);
    }
    return html.slice(i);
  }
  return undefined;
}

export function htmlToText(html: string, base?: string): PageText {
  const title = decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "").replace(/\s+/g, " ").trim();
  const body = html.replace(/<!--[\s\S]*?-->/g, "");
  const part = inside(body, ["main"]) ?? inside(body, ["article"]) ?? inside(body, ["body"]) ?? body;

  const links: string[] = [];
  const out: string[] = [];
  const stack: { name: string; keep: boolean }[] = [];
  let skip = 0;            // depth inside a dropped or hidden element
  let pre = false;
  let list: ("ul" | "ol")[] = [];
  let item = 0;
  let linkAt: { out: number; href?: string } | undefined;
  let cell = false;

  // The last two characters written, kept as they go: looking at the end of what is written must not mean joining it all.
  let tail = "";
  const emit = (s: string): void => { if (s) { out.push(s); tail = (tail + s).slice(-2); } };
  const newline = (n = 1): void => {
    const have = tail.endsWith("\n\n") ? 2 : tail.endsWith("\n") ? 1 : 0;
    if (have < n && out.length) emit("\n".repeat(n - have));
  };

  const resolve = (href: string): string | undefined => {
    if (!href || href.startsWith("#") || /^(javascript|mailto|tel|data):/i.test(href)) return undefined;
    try { return new URL(href, base).href; } catch { return undefined; }
  };

  let i = 0;
  while (i < part.length) {
    const lt = part.indexOf("<", i);
    const raw = part.slice(i, lt < 0 ? undefined : lt);
    if (raw && !skip) {
      const text = decodeEntities(raw);
      if (pre) emit(text);
      else {
        const squeezed = text.replace(/\s+/g, " ");
        const last = tail.slice(-1);
        emit(last === "" || last === "\n" || last === " " ? squeezed.replace(/^ /, "") : squeezed);
      }
    }
    if (lt < 0) break;
    const tag = tagAt(part, lt);
    if (!tag) { if (!skip) emit("<"); i = lt + 1; continue; }
    i = lt + tag.length;
    if (!tag.end && (tag.name === "script" || tag.name === "style")) {
      const close = part.toLowerCase().indexOf(`</${tag.name}`, i);
      i = close < 0 ? part.length : close;
      continue;
    }
    if (tag.end) {
      let k = stack.length - 1;
      while (k >= 0 && stack[k]!.name !== tag.name) k--;
      if (k < 0) continue;
      const closed = stack.splice(k);
      for (const c of closed.reverse()) {
        if (!c.keep) skip--;
        else after(c.name);
      }
      continue;
    }
    const void_ = VOID.has(tag.name) || tag.selfClosing;
    if (skip) { if (!void_) { stack.push({ name: tag.name, keep: false }); skip++; } continue; }
    if (DROPPED.has(tag.name) || hidden(tag)) { if (!void_) { stack.push({ name: tag.name, keep: false }); skip++; } continue; }
    before(tag);
    if (!void_) stack.push({ name: tag.name, keep: true });
    else if (tag.name === "br") emit(pre ? "\n" : "\n");
  }
  for (const c of stack.splice(0).reverse()) if (c.keep) after(c.name);

  function before(tag: Tag): void {
    const n = tag.name;
    if (/^h[1-6]$/.test(n)) { newline(2); emit(`${"#".repeat(Number(n[1]))} `); }
    else if (n === "ul" || n === "ol") { newline(list.length ? 1 : 2); list.push(n); if (n === "ol") item = 0; }
    else if (n === "li") { newline(); item++; emit(`${"  ".repeat(Math.max(0, list.length - 1))}${list.at(-1) === "ol" ? `${item}.` : "-"} `); }
    else if (n === "pre") { newline(2); emit("```\n"); pre = true; }
    else if (n === "code" && !pre) emit("`");
    else if (n === "tr") { newline(); cell = false; }
    else if (n === "td" || n === "th") { if (cell) emit(" | "); cell = true; }
    else if (n === "a") { const href = resolve(tag.attrs.href ?? ""); linkAt = { out: out.length, ...(href ? { href } : {}) }; }
    else if (n === "img" && tag.attrs.alt) emit(`[image: ${tag.attrs.alt.trim()}]`);
    else if (n === "blockquote") { newline(2); emit("> "); }
    else if (BLOCK.has(n)) newline(n === "p" || n === "table" ? 2 : 1);
  }

  function after(n: string): void {
    if (/^h[1-6]$/.test(n)) newline(2);
    else if (n === "ul" || n === "ol") { list.pop(); newline(list.length ? 1 : 2); }
    else if (n === "pre") { pre = false; if (!tail.endsWith("\n")) emit("\n"); emit("```"); newline(2); }
    else if (n === "code" && !pre) emit("`");
    else if (n === "a" && linkAt) {
      const words = out.slice(linkAt.out).join("").trim();
      // The sign a heading carries to link to itself is not text.
      if (/^[#¶§]$/.test(words)) { out.length = linkAt.out; tail = out.slice(-2).join("").slice(-2); }
      else if (words && linkAt.href && links.length < MOST_LINKS) {
        let k = links.indexOf(linkAt.href);
        if (k < 0) { links.push(linkAt.href); k = links.length - 1; }
        emit(` [${k + 1}]`);
      }
      linkAt = undefined;
    } else if (BLOCK.has(n)) newline(n === "p" || n === "table" || n === "blockquote" ? 2 : 1);
  }

  const text = out.join("").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return { title, text, links };
}

/** The links as lines to put after the text: `[3] https://…`. */
export const linkLines = (links: readonly string[]): string => links.map((l, i) => `[${i + 1}] ${l}`).join("\n");
