import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killTree, usesProcessGroups } from "../platform.ts";
import type { Tool } from "../types.ts";
import { isPrivateHost } from "./web-fetch.ts";
import { refusal } from "./web-guard.ts";
import { clip, num, outputBudget, str } from "./util.ts";

/**
 * A browser the agent can use: open a page, read it, click, type, go back. It drives the Chrome (or Chromium, Edge, Brave) that is
 * already on this computer through its remote-debugging protocol, so nothing is installed and nothing is added to navvied. The page is
 * given back as readable text, with every link and control numbered so the model can say "click 7". The browser runs with a profile of
 * its own that is thrown away, so it has none of the person's logins, history or cookies.
 */

const CANDIDATES: Record<string, string[]> = {
  darwin: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"],
  win32: ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"],
  linux: ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "brave-browser"],
};

/** Where a Chromium-based browser is on this computer, or nothing. */
export function findChrome(env: Record<string, string | undefined> = process.env, platform: string = process.platform, exists: (p: string) => boolean = existsSync, which: (c: string) => string | null = (c) => Bun.which(c)): string | undefined {
  if (env.NAVVIED_CHROME && exists(env.NAVVIED_CHROME)) return env.NAVVIED_CHROME;
  for (const c of CANDIDATES[platform] ?? CANDIDATES.linux!) {
    if (c.includes("/") || c.includes("\\")) { if (exists(c)) return c; } else { const found = which(c); if (found) return found; }
  }
  return undefined;
}

const IDLE_MS = 5 * 60_000;
const CALL_MS = 30_000;

interface Pending { resolve(v: unknown): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout> }

class StoppedAtStart extends Error {}

/** One browser, one page, spoken to over the DevTools protocol. */
/**
 * Where the browser listens, once it has said so: its file holds the port on one line and the address on the next. The file appears before
 * it is whole, so a file that holds less is not an answer yet.
 */
export function devToolsEndpoint(file: string): { port: string; path: string } | undefined {
  let text: string;
  try { text = readFileSync(file, "utf8"); } catch { return undefined; }
  const m = /^(\d+)\r?\n(\/\S+)/.exec(text);
  return m ? { port: m[1]!, path: m[2]! } : undefined;
}

/**
 * What a browser says when the network under it changed at the moment it went to a page (a new browser sees this on its first
 * navigation, and so does a person whose Wi-Fi or VPN switches): the page is asked for once more after a pause, and only once. Other
 * errors, and a second failure, are the answer. The pause comes before the page is waited for, so it is not part of the time the page
 * is given to load.
 */
const RETRIED: Record<string, number> = { "net::ERR_NETWORK_CHANGED": 300, "net::ERR_INTERNET_DISCONNECTED": 1_500 };

export async function openWithRetry(go: () => Promise<string | undefined>, wait: (ms: number) => Promise<unknown> = (ms) => new Promise((r) => setTimeout(r, ms))): Promise<string | undefined> {
  const first = await go();
  const pause = first === undefined ? undefined : RETRIED[first];
  if (pause === undefined) return first;
  await wait(pause);
  return go();
}

/** `NAVVIED_BROWSER_ARGS`: more flags for the browser, as a JSON list of texts (a proxy, a test); anything else is ignored. */
function extraFlags(): string[] {
  try {
    const list: unknown = JSON.parse(process.env.NAVVIED_BROWSER_ARGS ?? "[]");
    return Array.isArray(list) ? list.filter((f): f is string => typeof f === "string" && f.startsWith("--")) : [];
  } catch { return []; }
}

class Session {
  #socket!: WebSocket;
  #next = 1;
  #pending = new Map<number, Pending>();
  #sessionId = "";
  #child!: ChildProcess;
  #dir = "";
  #idle: ReturnType<typeof setTimeout> | undefined;
  closed = false;
  /** Whether this computer may be sent to local and private addresses (the host's choice, set at each call). */
  allowPrivate = false;
  /** Why the last request was not let through, for the sentence that tells the person a page could not be opened. */
  #lastRefusal = "";

  /** Starts the browser. One that stops while starting is started once more: a crash at launch is rare and does not repeat. */
  static async open(chrome: string): Promise<Session> {
    try { return await Session.start(chrome); } catch (e) { if (!(e instanceof StoppedAtStart)) throw e; return Session.start(chrome); }
  }

  static async start(chrome: string): Promise<Session> {
    const s = new Session();
    // The long form of the folder: a short 8.3 name (RUNNER~1) in a profile path is one more thing for a browser on Windows to trip over.
    s.#dir = realpathSync.native(mkdtempSync(join(tmpdir(), "navvied-browser-")));
    s.#child = spawn(chrome, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${s.#dir}`, "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-sync", "--mute-audio", "--hide-scrollbars", "--window-size=1280,900", ...(process.platform === "win32" ? ["--disable-gpu"] : []), ...(process.getuid?.() === 0 || process.env.NAVVIED_BROWSER_NO_SANDBOX === "1" ? ["--no-sandbox"] : []), ...extraFlags(), "about:blank"], { detached: usesProcessGroups(), stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let said = "", stopped: number | null | undefined;
    s.#child.stderr?.on("data", (d: Buffer) => { said = (said + d.toString("utf8")).slice(-600); });
    s.#child.on("exit", (code) => { stopped = code; s.close(); });
    s.#child.on("error", (e) => { said += e.message; stopped = null; s.close(); });
    const portFile = join(s.#dir, "DevToolsActivePort");
    const wait = Number(process.env.NAVVIED_BROWSER_START_MS) || 15_000;
    const until = Date.now() + wait;
    let endpoint: { port: string; path: string } | undefined;
    while (!(endpoint = devToolsEndpoint(portFile))) {
      if (stopped !== undefined) throw new StoppedAtStart(`the browser stopped while starting (exit ${stopped})${said.trim() ? `: ${said.trim().split("\n").pop()}` : ""}`);
      if (s.closed || Date.now() > until) {
        // What was seen, so that a start that never ends can be told from one that never began.
        const seen = [s.#child.pid === undefined ? "never started" : s.#child.exitCode === null ? "still running" : `exit ${s.#child.exitCode}`, `profile: ${(() => { try { return readdirSync(s.#dir).slice(0, 12).join(", ") || "empty"; } catch { return "gone"; } })()}`, said.trim() ? `said: ${said.trim().split("\n").pop()}` : "said nothing"].join("; ");
        s.close();
        throw new Error(`the browser did not start in ${Math.round(wait / 1000)} s (${seen})`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    s.#socket = new WebSocket(`ws://127.0.0.1:${endpoint.port}${endpoint.path}`);
    await new Promise<void>((resolve, reject) => { s.#socket.onopen = () => resolve(); s.#socket.onerror = () => reject(new Error("could not connect to the browser")); });
    s.#socket.onmessage = (m) => s.#message(String(m.data));
    s.#socket.onclose = () => s.close();
    const target = (await s.#send("Target.createTarget", { url: "about:blank" })) as { targetId: string };
    const attached = (await s.#send("Target.attachToTarget", { targetId: target.targetId, flatten: true })) as { sessionId: string };
    s.#sessionId = attached.sessionId;
    await s.#send("Page.enable");
    await s.#send("Runtime.enable");
    // Every request the page makes waits here until it has been looked at: a document, an image, a script's fetch.
    await s.#send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
    s.touch();
    return s;
  }

  touch(): void { clearTimeout(this.#idle); this.#idle = setTimeout(() => this.close(), IDLE_MS); this.#idle.unref?.(); }

  #message(text: string): void {
    let m: { id?: number; method?: string; params?: { requestId?: string; request?: { url?: string } }; result?: unknown; error?: { message?: string } };
    try { m = JSON.parse(text); } catch { return; }
    if (m.method === "Fetch.requestPaused" && m.params?.requestId) { void this.#gate(m.params.requestId, m.params.request?.url ?? ""); return; }
    if (typeof m.id !== "number") return;
    const p = this.#pending.get(m.id);
    if (!p) return;
    this.#pending.delete(m.id);
    clearTimeout(p.timer);
    if (m.error) p.reject(new Error(m.error.message ?? "the browser reported an error")); else p.resolve(m.result);
  }

  /**
   * A request the page makes is let through, or failed, by the same look as the web tools make of an address: a name is looked up and every
   * address it has must be public, and a name that cannot be looked up is not let through. It is asked of every request, so a page that
   * redirects, navigates or loads something from a local or private address cannot reach it. Only addresses of the network are looked at:
   * what is inside the page (`data:`, `blob:`) goes nowhere, and a file on this computer is never loaded.
   */
  async #gate(requestId: string, address: string): Promise<void> {
    let why: string | undefined;
    try {
      const url = new URL(address);
      why = url.protocol === "file:" ? "files on this computer are not opened." : url.protocol === "http:" || url.protocol === "https:" ? await refusal(url, this.allowPrivate) : undefined;
    } catch { why = "the address could not be read, so it was not loaded."; }
    if (why) this.#lastRefusal = why;
    try { await this.#send(why ? "Fetch.failRequest" : "Fetch.continueRequest", why ? { requestId, errorReason: "AccessDenied" } : { requestId }); } catch { /* the browser is closing */ }
  }

  #send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (this.closed) { reject(new Error("the browser is closed")); return; }
      const id = this.#next++;
      const timer = setTimeout(() => { this.#pending.delete(id); reject(new Error(`${method} took too long`)); }, CALL_MS);
      this.#pending.set(id, { resolve, reject, timer });
      this.#socket.send(JSON.stringify({ id, method, params, ...(this.#sessionId ? { sessionId: this.#sessionId } : {}) }));
    });
  }

  async eval<T>(expression: string): Promise<T> {
    this.touch();
    const r = (await this.#send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })) as { result?: { value?: T }; exceptionDetails?: { exception?: { description?: string }; text?: string } };
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description?.split("\n")[0] ?? r.exceptionDetails.text ?? "the page script failed");
    return r.result?.value as T;
  }

  async navigate(url: string): Promise<void> {
    this.touch();
    this.#lastRefusal = "";
    const error = await openWithRetry(async () => ((await this.#send("Page.navigate", { url })) as { errorText?: string }).errorText);
    if (error) throw new Error(this.#lastRefusal && /ACCESS_DENIED/.test(error) ? `the page was not opened: ${this.#lastRefusal}` : `the page could not be opened (${error})`);
    await this.settle();
  }

  async back(): Promise<boolean> {
    const h = (await this.#send("Page.getNavigationHistory")) as { currentIndex: number; entries: { id: number }[] };
    if (h.currentIndex <= 0) return false;
    await this.#send("Page.navigateToHistoryEntry", { entryId: h.entries[h.currentIndex - 1]!.id });
    await this.settle();
    return true;
  }

  /** Waits for the page to finish loading, and a moment longer for what scripts add at once. */
  async settle(): Promise<void> {
    const until = Date.now() + 12_000;
    await new Promise((r) => setTimeout(r, 250));
    while (Date.now() < until) {
      try { if ((await this.eval<string>("document.readyState")) === "complete") break; } catch { /* the page is changing */ }
      await new Promise((r) => setTimeout(r, 150));
    }
    await new Promise((r) => setTimeout(r, 400));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.#idle);
    for (const p of this.#pending.values()) { clearTimeout(p.timer); p.reject(new Error("the browser was closed")); }
    this.#pending.clear();
    try { this.#socket?.close(); } catch { /* already closed */ }
    if (this.#child) killTree(this.#child);
    try { if (this.#dir) rmSync(this.#dir, { recursive: true, force: true }); } catch { /* the folder is removed with the temporary files */ }
  }
}

/** Runs in the page: marks what a person could click or fill in with a number, and reads the page as text. */
const SNAPSHOT = `(() => {
  const seen = []; let n = 0;
  const visible = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
  const label = (e) => (e.getAttribute("aria-label") || e.innerText || e.value || e.placeholder || e.title || e.alt || e.name || "").replace(/\\s+/g, " ").trim().slice(0, 80);
  document.querySelectorAll("[data-nv]").forEach((e) => e.removeAttribute("data-nv"));
  for (const e of document.querySelectorAll("a[href], button, input:not([type=hidden]), textarea, select, [role=button], [role=link], [onclick], summary")) {
    if (!visible(e) || n >= 80) continue;
    n++; e.setAttribute("data-nv", String(n));
    const tag = e.tagName.toLowerCase();
    const kind = tag === "a" ? "link" : tag === "select" ? "choice" : tag === "textarea" || (tag === "input" && !["button", "submit", "checkbox", "radio", "reset", "image"].includes(e.type)) ? "field" : (tag === "input" && ["checkbox", "radio"].includes(e.type)) ? e.type : "button";
    seen.push({ n, kind, label: label(e), href: tag === "a" ? e.getAttribute("href") : undefined, value: kind === "field" ? e.value : kind === "choice" ? e.value : (e.checked !== undefined && (e.type === "checkbox" || e.type === "radio")) ? String(e.checked) : undefined, options: tag === "select" ? [...e.options].slice(0, 12).map((o) => o.text.trim()) : undefined });
  }
  return { url: location.href, title: document.title, text: (document.body ? document.body.innerText : "").replace(/\\n{3,}/g, "\\n\\n").trim(), controls: seen };
})()`;

interface Shot { url: string; title: string; text: string; controls: { n: number; kind: string; label: string; href?: string; value?: string; options?: string[] }[] }

export const describeShot = (s: Shot, window: number | undefined, offset = 0): string => {
  // The page text takes most of what one result may be, as any tool result does; what is left is for the controls.
  const most = Math.max(2_000, Math.round(outputBudget(window) * 0.7));
  const controls = s.controls.map((c) => `[${c.n}] ${c.kind}${c.label ? ` "${c.label}"` : ""}${c.href ? ` -> ${c.href.slice(0, 100)}` : ""}${c.value !== undefined && c.value !== "" ? ` (now: ${c.value.slice(0, 40)})` : ""}${c.options ? ` (options: ${c.options.join(" | ")})` : ""}`).join("\n");
  return clip(`Page: ${s.title || "(no title)"}\nAddress: ${s.url}\n\n${s.text.slice(offset, offset + most)}${s.text.length > offset + most ? `\n[characters ${offset}–${offset + most} of ${s.text.length}; the rest: Browser {"action": "read", "offset": ${offset + most}}]` : ""}\n\n${controls ? `What can be used on this page:\n${controls}` : "Nothing on this page can be clicked or filled in."}`);
};

let session: Session | undefined;
process.once("exit", () => session?.close());
/** For tests, and for an engine that shuts down: the browser is closed. */
export const closeBrowser = (): void => { session?.close(); session = undefined; };

const refused = (url: URL, allowPrivate: boolean): string | undefined => {
  if (url.protocol !== "http:" && url.protocol !== "https:") return "Error: only http(s) addresses can be opened.";
  if (!allowPrivate && isPrivateHost(url.hostname)) return "Error: opening local or private network addresses is not allowed.";
  return undefined;
};

export const browser: Tool = {
  name: "Browser",
  readOnly: false,
  offeredWhen: ({ userText }) => !!findChrome() && /https?:\/\/|\bbrowse|\bbrowser\b|web ?(site|page)|\bonline\b|\blog ?in\b|\bclick\b|\bsite\b/i.test(userText),
  description: "Use a web browser: open a page, read it, click, fill in fields, go back. Every link and control on the page is numbered; click or type by that number. The browser has none of the user's logins. Actions: open (url), read, click (ref), type (ref, text, submit), choose (ref, text), scroll (direction up or down), back, close.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["open", "read", "click", "type", "choose", "scroll", "back", "close"] },
      url: { type: "string" }, ref: { type: "number", description: "the number shown for a link or control" },
      offset: { type: "number", description: "with read: characters of the page already read" }, text: { type: "string" }, submit: { type: "boolean", description: "press Enter after typing" }, direction: { type: "string", enum: ["up", "down"] },
    },
    required: ["action"],
  },
  title: (a) => (str(a.action) === "open" ? `Open ${str(a.url)}` : `Browser: ${str(a.action)}${a.ref !== undefined ? ` ${a.ref}` : ""}`),
  async run(a, ctx) {
    const action = str(a.action);
    if (action === "close") { closeBrowser(); return "The browser is closed."; }
    const chrome = findChrome();
    if (!chrome) return "Error: no browser was found on this computer. Install Chrome, Chromium or Edge, or set NAVVIED_CHROME to its path.";
    let url: URL | undefined;
    if (action === "open") {
      try { url = new URL(str(a.url)); } catch { return "Error: that is not a valid address."; }
      const no = refused(url, ctx.allowPrivateNetwork);
      if (no) return no;
    }
    try {
      if (!session || session.closed) session = await Session.open(chrome);
      const s = session;
      s.allowPrivate = ctx.allowPrivateNetwork;
      if (action === "open") { await s.navigate(url!.href); }
      else if (action === "back") { if (!(await s.back())) return "Error: there is no earlier page."; }
      else if (action === "scroll") { await s.eval(`window.scrollBy(0, ${a.direction === "up" ? "-" : ""}Math.round(innerHeight * 0.85))`); await new Promise((r) => setTimeout(r, 300)); }
      else if (action === "click" || action === "type" || action === "choose") {
        const ref = Math.floor(num(a.ref, 0));
        if (ref < 1) return "Error: say which control with ref (the number shown on the page).";
        const found = await s.eval<boolean>(`!!document.querySelector('[data-nv="${ref}"]')`);
        if (!found) return `Error: there is no control ${ref} on this page now. Use read to see the page again.`;
        if (action === "click") {
          // A click that leaves the page is followed, and one that must not go to a private address is not allowed to.
          const target = await s.eval<string | null>(`(() => { const e = document.querySelector('[data-nv="${ref}"]'); return e && e.href ? e.href : null; })()`);
          if (target) { try { const no = refused(new URL(target), ctx.allowPrivateNetwork); if (no) return no; } catch { /* not an address */ } }
          await s.eval(`(() => { const e = document.querySelector('[data-nv="${ref}"]'); e.scrollIntoView({ block: "center" }); e.click(); })()`);
        } else if (action === "type") {
          const text = JSON.stringify(str(a.text));
          await s.eval(`(() => { const e = document.querySelector('[data-nv="${ref}"]'); e.scrollIntoView({ block: "center" }); e.focus(); const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(e), "value")?.set; if (set) set.call(e, ${text}); else e.value = ${text}; e.dispatchEvent(new Event("input", { bubbles: true })); e.dispatchEvent(new Event("change", { bubbles: true })); })()`);
          if (a.submit === true) await s.eval(`(() => { const e = document.querySelector('[data-nv="${ref}"]'); const f = e.form; e.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true })); if (f) { if (f.requestSubmit) f.requestSubmit(); else f.submit(); } })()`);
        } else {
          const want = JSON.stringify(str(a.text));
          const done = await s.eval<boolean>(`(() => { const e = document.querySelector('[data-nv="${ref}"]'); const o = [...e.options].find((x) => x.text.trim().toLowerCase() === ${want}.toLowerCase() || x.value === ${want}); if (!o) return false; e.value = o.value; e.dispatchEvent(new Event("input", { bubbles: true })); e.dispatchEvent(new Event("change", { bubbles: true })); return true; })()`);
          if (!done) return `Error: control ${ref} has no choice "${str(a.text)}".`;
        }
        await s.settle();
      } else if (action !== "read") return `Error: unknown action "${action}".`;
      const shot = await s.eval<Shot>(SNAPSHOT);
      // A page that sent the browser to a private address is not read either.
      try { const landed = new URL(shot.url); const no = shot.url === "about:blank" ? undefined : refused(landed, ctx.allowPrivateNetwork); if (no) { await s.navigate("about:blank"); return no; } } catch { /* about: pages */ }
      return describeShot(shot, ctx.window, action === "read" ? Math.max(0, Math.floor(num(a.offset, 0))) : 0);
    } catch (e) {
      const dead = session?.closed;
      if (dead) session = undefined;
      return `Error: ${e instanceof Error ? e.message : String(e)}${dead ? " (the browser was closed; open the page again)" : ""}`;
    }
  },
};
