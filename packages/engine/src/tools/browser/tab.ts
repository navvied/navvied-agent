import { readTree, type AxNode, type Ref } from "./ax.ts";
import type { Cdp } from "./cdp.ts";
import { openWithRetry } from "./launch.ts";

export interface Dialog { type: string; message: string; defaultPrompt?: string }

/** A dialog is open: the page does nothing until it is answered, so no other command is sent. */
export class DialogOpen extends Error { constructor(readonly dialog: Dialog) { super("a dialog is open"); } }
/** A number that no longer stands for anything on the page; the text says why, and what to do. */
export class RefError extends Error {}

const RING = 100;
const GONE = /No node|Could not find node|node with given id|does not belong|Cannot find context/i;

const KEYS: Record<string, { key: string; code: string; vk: number; text?: string }> = {
  enter: { key: "Enter", code: "Enter", vk: 13, text: "\r" }, escape: { key: "Escape", code: "Escape", vk: 27 }, tab: { key: "Tab", code: "Tab", vk: 9 },
  backspace: { key: "Backspace", code: "Backspace", vk: 8 }, space: { key: " ", code: "Space", vk: 32, text: " " }, delete: { key: "Delete", code: "Delete", vk: 46 },
  arrowup: { key: "ArrowUp", code: "ArrowUp", vk: 38 }, arrowdown: { key: "ArrowDown", code: "ArrowDown", vk: 40 }, arrowleft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 }, arrowright: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  pagedown: { key: "PageDown", code: "PageDown", vk: 34 }, pageup: { key: "PageUp", code: "PageUp", vk: 33 }, home: { key: "Home", code: "Home", vk: 36 }, end: { key: "End", code: "End", vk: 35 },
};
export const KEY_NAMES = Object.values(KEYS).map((k) => k.key.trim() || "Space");

/** One page of the browser: what it shows, the numbers it gave, the dialog it waits on, and what it reported. */
export class Tab {
  refs = new Map<number, Ref>();
  /** Where the page went since the numbers were given; the numbers are void until it is read again. */
  stale = "";
  /** The text of the last reading, so that the rest of a long page is cut from the same numbers. */
  reading = "";
  dialog: Dialog | undefined;
  /** The input a file chooser the page opened is for. */
  chooser: number | undefined;
  title = "";
  url = "about:blank";
  console: string[] = [];
  failures: string[] = [];
  /** Why the last request was not let through, for the sentence that tells the person a page could not be opened. */
  refusal = "";
  /** A challenge (a code, a check for people) the person was already asked about, by page address. */
  asked = "";
  #inflight = new Set<string>();
  #urls = new Map<string, string>();
  #watchers = new Set<(d: DialogOpen) => void>();
  #quiet = new Set<() => void>();

  constructor(readonly cdp: Cdp, readonly targetId: string, readonly sessionId: string, private readonly gate: (url: string) => Promise<string | undefined>) {}

  async init(): Promise<void> {
    const on = (m: string, p: Record<string, unknown> = {}): Promise<unknown> => this.cdp.send(m, p, this.sessionId);
    // All at once, the resume last: a page the browser holds at its start does not answer before it is let go, and commands are taken in order.
    await Promise.all([
      on("Page.enable"), on("Runtime.enable"), on("Network.enable"), on("DOM.enable"),
      // Every request the page makes waits here until it has been looked at: a document, an image, a script's fetch.
      on("Fetch.enable", { patterns: [{ urlPattern: "*" }] }),
      on("Page.setInterceptFileChooserDialog", { enabled: true }).catch(() => undefined),
      on("Runtime.runIfWaitingForDebugger").catch(() => undefined),
    ]);
  }

  /** What the browser says about this page on its own. */
  handle(method: string, p: Record<string, any>): void {
    switch (method) {
      case "Page.javascriptDialogOpening": {
        this.dialog = { type: String(p.type), message: String(p.message ?? ""), ...(p.defaultPrompt ? { defaultPrompt: String(p.defaultPrompt) } : {}) };
        for (const w of this.#watchers) w(new DialogOpen(this.dialog));
        break;
      }
      case "Page.javascriptDialogClosed": this.dialog = undefined; break;
      case "Page.fileChooserOpened": if (typeof p.backendNodeId === "number") this.chooser = p.backendNodeId; break;
      case "Page.frameNavigated":
        if (!p.frame?.parentId) { this.stale = String(p.frame?.url ?? ""); this.url = this.stale; this.console = []; this.failures = []; this.chooser = undefined; }
        break;
      case "Runtime.consoleAPICalled": this.#add(this.console, `[${p.type}] ${(p.args ?? []).map((a: any) => a.value ?? a.description ?? a.type).join(" ")}`); break;
      case "Runtime.exceptionThrown": this.#add(this.console, `[error] ${p.exceptionDetails?.exception?.description?.split("\n")[0] ?? p.exceptionDetails?.text ?? "a script failed"}`); break;
      case "Network.requestWillBeSent": if (!["WebSocket", "EventSource", "Ping"].includes(p.type)) { this.#inflight.add(p.requestId); this.#urls.set(p.requestId, String(p.request?.url ?? "")); for (const q of this.#quiet) q(); } break;
      case "Network.loadingFinished": this.#done(p.requestId); break;
      case "Network.loadingFailed": {
        const url = this.#urls.get(p.requestId) ?? "";
        if (!p.canceled) this.#add(this.failures, `${url} (${this.refusal && /ACCESS_DENIED|BLOCKED/.test(String(p.errorText)) ? this.refusal : p.errorText})`);
        this.#done(p.requestId);
        break;
      }
      case "Network.responseReceived": if (p.response?.status >= 400) this.#add(this.failures, `${p.response.status} ${p.response.url}`); break;
      case "Fetch.requestPaused": void this.#paused(p.requestId, String(p.request?.url ?? "")); break;
    }
  }

  /** The proxy refused a connection to `host`: it is this tab's refusal only when this tab asked for that host (the browser also makes requests of its own). */
  refuseHost(host: string, why: string): void {
    const bare = host.replace(/^\[|\]$/g, "").toLowerCase();
    for (const u of [...this.#urls.values(), this.url]) { try { if (new URL(u).hostname.replace(/^\[|\]$/g, "").toLowerCase() === bare) { this.refusal = why; return; } } catch { /* not an address */ } }
  }

  #add(list: string[], line: string): void { list.push(line.slice(0, 300)); if (list.length > RING) list.shift(); }
  #done(id: string): void { this.#inflight.delete(id); this.#urls.delete(id); if (!this.#inflight.size) for (const q of this.#quiet) q(); }

  async #paused(requestId: string, url: string): Promise<void> {
    const why = await this.gate(url);
    if (why) this.refusal = why;
    try { await this.cdp.send(why ? "Fetch.failRequest" : "Fetch.continueRequest", why ? { requestId, errorReason: "AccessDenied" } : { requestId }, this.sessionId); } catch { /* the browser is closing */ }
  }

  /** A command to this page. A dialog that opens while it waits ends the wait: the page will not answer before the dialog is. */
  async send<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.dialog && method !== "Page.handleJavaScriptDialog") throw new DialogOpen(this.dialog);
    const call = this.cdp.send<T>(method, params, this.sessionId);
    if (method === "Page.handleJavaScriptDialog") return call;
    call.catch(() => undefined);
    let watcher!: (d: DialogOpen) => void;
    const opened = new Promise<never>((_, reject) => { watcher = reject; this.#watchers.add(watcher); });
    try { return await Promise.race([call, opened]); } finally { this.#watchers.delete(watcher); }
  }

  async eval<T>(expression: string): Promise<T> {
    const r = await this.send<{ result?: { value?: T }; exceptionDetails?: { exception?: { description?: string }; text?: string } }>("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description?.split("\n")[0] ?? r.exceptionDetails.text ?? "the page script failed");
    return r.result?.value as T;
  }

  /** Runs a function on one element and gives back what it returns. */
  async onElement<T>(ref: Ref, fn: string, args: unknown[] = []): Promise<T> {
    try {
      const { object } = await this.send<{ object: { objectId: string } }>("DOM.resolveNode", { backendNodeId: ref.node });
      const r = await this.send<{ result?: { value?: T }; exceptionDetails?: { exception?: { description?: string } } }>("Runtime.callFunctionOn", { objectId: object.objectId, functionDeclaration: fn, arguments: args.map((value) => ({ value })), returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description?.split("\n")[0] ?? "the page script failed");
      return r.result?.value as T;
    } catch (e) { if (e instanceof Error && GONE.test(e.message)) throw new RefError(`control "${ref.name || ref.role}" is no longer on the page.`); throw e; }
  }

  /** Reads the page again: new numbers, and the old ones are void. */
  async read(): Promise<string> {
    const { nodes } = await this.send<{ nodes: AxNode[] }>("Accessibility.getFullAXTree");
    const { lines, refs } = readTree(nodes);
    const m = await this.eval<{ t: string; u: string; y: number; h: number; v: number }>("({ t: document.title, u: location.href, y: Math.round(scrollY), h: document.documentElement.scrollHeight, v: innerHeight })");
    this.refs = refs;
    this.stale = "";
    this.title = m.t;
    this.url = m.u;
    const left = Math.max(0, m.h - m.v - m.y);
    this.reading = `Page: ${m.t || "(no title)"}\nAddress: ${m.u}\n${m.h > m.v ? `Scrolled ${m.y} of ${Math.max(0, m.h - m.v)} px${left > 0 ? "; more below" : ""}\n` : ""}\n${lines.join("\n") || "(nothing on this page)"}`;
    return this.reading;
  }

  /** The control a number stands for. The browser is asked something first: what it said about the page before this moment has reached us by then. */
  async ref(n: number): Promise<Ref> {
    await this.send("Runtime.evaluate", { expression: "0" });
    if (this.stale) throw new RefError(`the page went to ${this.stale} since the numbers were given, so they no longer apply. Nothing was done.`);
    const r = this.refs.get(n);
    if (!r) throw new RefError(this.refs.size ? `there is no control ${n} on this page now.` : "no controls have been numbered yet.");
    return r;
  }

  async click(ref: Ref): Promise<void> {
    try {
      await this.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: ref.node }).catch((e: unknown) => { if (e instanceof DialogOpen) throw e; });
      const q = (await this.send<{ quads: number[][] }>("DOM.getContentQuads", { backendNodeId: ref.node }).catch((e: unknown) => { if (e instanceof Error && GONE.test(e.message)) throw e; return { quads: [] as number[][] }; })).quads[0];
      if (!q || q.length < 8) { await this.onElement(ref, "function () { this.click(); }"); return; }
      const x = (q[0]! + q[2]! + q[4]! + q[6]!) / 4, y = (q[1]! + q[3]! + q[5]! + q[7]!) / 4;
      await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
      await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    } catch (e) { if (e instanceof Error && GONE.test(e.message)) throw new RefError(`control "${ref.name || ref.role}" is no longer on the page.`); throw e; }
  }

  async press(key: string): Promise<boolean> {
    const k = KEYS[key.toLowerCase().replace(/\s/g, "")];
    if (!k) return false;
    const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk };
    await this.send("Input.dispatchKeyEvent", { type: k.text ? "keyDown" : "rawKeyDown", ...base, ...(k.text ? { text: k.text } : {}) });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    return true;
  }

  async navigate(url: string): Promise<void> {
    this.refusal = "";
    const error = await openWithRetry(async () => ((await this.send<{ errorText?: string }>("Page.navigate", { url })).errorText));
    if (error) throw new Error(this.refusal && /ACCESS_DENIED/.test(error) ? `the page was not opened: ${this.refusal}` : `the page could not be opened (${error})`);
    await this.settle();
  }

  async back(): Promise<boolean> {
    const h = await this.send<{ currentIndex: number; entries: { id: number }[] }>("Page.getNavigationHistory");
    if (h.currentIndex <= 0) return false;
    await this.send("Page.navigateToHistoryEntry", { entryId: h.entries[h.currentIndex - 1]!.id });
    await this.settle();
    return true;
  }

  /** Waits until no request is outstanding for `quietMs`, or `maxMs` has passed; whether it did. */
  idle(quietMs: number, maxMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      let quiet: ReturnType<typeof setTimeout> | undefined;
      const end = (v: boolean): void => { clearTimeout(quiet); clearTimeout(limit); this.#quiet.delete(check); resolve(v); };
      const check = (): void => { clearTimeout(quiet); if (!this.#inflight.size) quiet = setTimeout(() => end(true), quietMs); };
      const limit = setTimeout(() => end(false), maxMs);
      this.#quiet.add(check);
      check();
    });
  }

  /** Waits for the page to finish loading, and for what scripts then ask for. */
  async settle(): Promise<void> {
    const until = Date.now() + 12_000;
    while (Date.now() < until) {
      try { if ((await this.eval<string>("document.readyState")) === "complete") break; } catch (e) { if (e instanceof DialogOpen) throw e; }
      await new Promise((r) => setTimeout(r, 100));
    }
    await this.idle(300, 5_000);
  }
}
