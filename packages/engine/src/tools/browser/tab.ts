import type { BrowserNote } from "@navvied/protocol";
import { FRAME_ROLES, readTree, type AxNode, type Doc, type Place, type Ref } from "./ax.ts";
import type { Cdp } from "./cdp.ts";
import { openWithRetry } from "./launch.ts";

export interface Dialog { type: string; message: string; defaultPrompt?: string }

/** A dialog is open: the page does nothing until it is answered, so no other command is sent. */
const TOOK_TOO_LONG = /took too long$/;
const MOST_WAITED_FOR = 3;

export const stillWaitedFor = (addresses: Iterable<string>): string => {
  const shown = [...addresses].slice(0, MOST_WAITED_FOR).map((address) => { try { const url = new URL(address); return `${url.host}${url.pathname}`; } catch { return "an address that cannot be read"; } });
  return shown.length ? `still waiting for an answer from ${shown.join(", ")}` : "the page asked the network for nothing that is still unanswered";
};

export class DialogOpen extends Error { constructor(readonly dialog: Dialog) { super("a dialog is open"); } }
/** A number that no longer stands for anything on the page; the text says why, and what to do. */
export class RefError extends Error { constructor(message: string, readonly why: Extract<BrowserNote, { what: "ref" }>["why"]) { super(message); } }

const RING = 100;
const GONE = /No node|Could not find node|node with given id|does not belong|Cannot find context|Session with given id|Target closed/i;
const MOST_FRAMES = 24;
const MOST_DEPTH = 3;

const hostOf = (url: string): string => { try { return new URL(url).hostname.toLowerCase(); } catch { return ""; } };

export interface Point { x: number; y: number }
/** The picture the model was last given of the whole window: its size in pixels, and the size of the window it shows in the page's own units. */
export interface Shot { width: number; height: number; cssWidth: number; cssHeight: number }

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
  #refusals = new Map<string, string>();
  #documents = new Set<string>();
  /** A challenge (a code, a check for people) the person was already asked about, by page address. */
  asked = "";
  /** What the last picture of the whole window was, so that a place in it can be turned into a place on the page. */
  shot: Shot | undefined;
  /** What a drag that began in the page carries (set by the browser while drags are held back, see `drag`). */
  dragData: unknown;
  /** The frames the browser runs apart from this page (another site's frame), by their id: the session that speaks for each. */
  #frames = new Map<string, string>();
  #inflight = new Set<string>();
  #urls = new Map<string, string>();
  #watchers = new Set<(d: DialogOpen) => void>();
  #dialogsAnnounced = 0;
  #quiet = new Set<() => void>();

  constructor(readonly cdp: Cdp, readonly targetId: string, readonly sessionId: string, private readonly gate: (url: string) => Promise<string | undefined>, private readonly said: (note: BrowserNote) => void = () => undefined) {}

  async init(): Promise<void> {
    const on = (m: string, p: Record<string, unknown> = {}): Promise<unknown> => this.cdp.send(m, p, this.sessionId);
    const required = (m: string, p?: Record<string, unknown>): Promise<unknown> => on(m, p).catch((e: Error) => { throw new Error(`the page could not be set up (${m}): ${e.message}`); });
    await Promise.all([
      required("Page.enable"), required("Runtime.enable"), required("Network.enable"), required("DOM.enable"),
      required("Fetch.enable", { patterns: [{ urlPattern: "*" }] }),
      on("Page.setInterceptFileChooserDialog", { enabled: true }).catch(() => undefined),
      on("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }).catch(() => undefined),
      on("Runtime.runIfWaitingForDebugger").catch(() => undefined),
    ]);
  }

  /** A frame that runs apart from the page has come: its requests go through the same look, then it is let go. */
  async attachFrame(sessionId: string, targetId: string): Promise<void> {
    this.#frames.set(targetId, sessionId);
    const on = (m: string, p: Record<string, unknown> = {}): Promise<unknown> => this.cdp.send(m, p, sessionId).catch(() => undefined);
    await Promise.all([
      // The network too: the page asks for a frame's document, but the end of that request is said by the frame, and a request that never ends keeps the page from ever being quiet.
      on("DOM.enable"), on("Network.enable"), on("Fetch.enable", { patterns: [{ urlPattern: "*" }] }),
      on("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }),
      on("Runtime.runIfWaitingForDebugger"),
    ]);
  }

  detachFrame(sessionId: string): void { for (const [id, s] of this.#frames) if (s === sessionId) this.#frames.delete(id); }

  /** What the browser says about this page on its own (`session`: the one it was said on, a frame's or the page's). */
  handle(method: string, p: Record<string, any>, session: string = this.sessionId): void {
    switch (method) {
      case "Page.javascriptDialogOpening": {
        this.#dialogsAnnounced += 1;
        this.dialog = { type: String(p.type), message: String(p.message ?? ""), ...(p.defaultPrompt ? { defaultPrompt: String(p.defaultPrompt) } : {}) };
        this.said({ what: "dialog", state: "opened", type: this.dialog.type, message: this.dialog.message.slice(0, 500), ...(this.dialog.defaultPrompt ? { defaultPrompt: this.dialog.defaultPrompt.slice(0, 500) } : {}) });
        for (const w of this.#watchers) w(new DialogOpen(this.dialog));
        break;
      }
      case "Page.javascriptDialogClosed": this.dialog = undefined; break;
      case "Page.fileChooserOpened": if (typeof p.backendNodeId === "number") { this.chooser = p.backendNodeId; this.said({ what: "upload", state: "asked" }); } break;
      case "Page.frameNavigated":
        if (!p.frame?.parentId) { this.stale = String(p.frame?.url ?? ""); this.url = this.stale; this.console = []; this.failures = []; this.chooser = undefined; }
        break;
      case "Runtime.consoleAPICalled": this.#add(this.console, `[${p.type}] ${(p.args ?? []).map((a: any) => a.value ?? a.description ?? a.type).join(" ")}`); break;
      case "Runtime.exceptionThrown": this.#add(this.console, `[error] ${p.exceptionDetails?.exception?.description?.split("\n")[0] ?? p.exceptionDetails?.text ?? "a script failed"}`); break;
      case "Network.requestWillBeSent": if (!["WebSocket", "EventSource", "Ping"].includes(p.type)) { this.#inflight.add(p.requestId); this.#urls.set(p.requestId, String(p.request?.url ?? "")); for (const q of this.#quiet) q(); } break;
      case "Network.loadingFinished": this.#done(p.requestId); break;
      case "Network.loadingFailed": {
        const url = this.#urls.get(p.requestId) ?? "";
        if (!p.canceled) this.#add(this.failures, `${url} (${this.#why(url) && /ACCESS_DENIED|BLOCKED/.test(String(p.errorText)) ? this.#why(url) : p.errorText})`);
        this.#done(p.requestId);
        break;
      }
      case "Network.responseReceived": if (p.response?.status >= 400) this.#add(this.failures, `${p.response.status} ${p.response.url}`); break;
      case "Fetch.requestPaused": if (p.resourceType === "Document") this.#documents.add(hostOf(String(p.request?.url ?? ""))); void this.#paused(p.requestId, String(p.request?.url ?? ""), session); break;
      case "Input.dragIntercepted": this.dragData = p.data; break;
    }
  }

  /**
   * Why a request was not let through, by the host it was for. The sentence that tells the person a page could not be opened gives the
   * reason for a document this page asked for (the address, or where a redirect led), never one for a request somebody else made.
   */
  refuse(host: string, why: string): void { this.#refusals.set(host, why); }
  get refusal(): string {
    for (const host of [...this.#documents].reverse()) { const why = this.#refusals.get(host); if (why) return why; }
    return "";
  }
  #why(url: string): string { return this.#refusals.get(hostOf(url)) ?? ""; }

  #add(list: string[], line: string): void { list.push(line.slice(0, 300)); if (list.length > RING) list.shift(); }
  #done(id: string): void { this.#inflight.delete(id); this.#urls.delete(id); if (!this.#inflight.size) for (const q of this.#quiet) q(); }

  async #paused(requestId: string, url: string, session: string): Promise<void> {
    const why = await this.gate(url);
    if (why) this.refuse(hostOf(url), why);
    try { await this.cdp.send(why ? "Fetch.failRequest" : "Fetch.continueRequest", why ? { requestId, errorReason: "AccessDenied" } : { requestId }, session); } catch { /* the browser is closing */ }
  }

  /** A command to this page, or to one of its frames (`session`). A dialog that opens while it waits ends the wait: the page will not answer before the dialog is. */
  async send<T = any>(method: string, params: Record<string, unknown> = {}, session: string = this.sessionId): Promise<T> {
    if (this.dialog && method !== "Page.handleJavaScriptDialog") throw new DialogOpen(this.dialog);
    const call = this.cdp.send<T>(method, params, session);
    if (method === "Page.handleJavaScriptDialog") return call;
    call.catch(() => undefined);
    let watcher!: (d: DialogOpen) => void;
    const opened = new Promise<never>((_, reject) => { watcher = reject; this.#watchers.add(watcher); });
    try { return await Promise.race([call, opened]); }
    catch (e) { throw e instanceof Error && TOOK_TOO_LONG.test(e.message) ? new Error(`${e.message} (dialogs the browser announced for this page: ${this.#dialogsAnnounced})`) : e; }
    finally { this.#watchers.delete(watcher); }
  }

  async eval<T>(expression: string): Promise<T> {
    const r = await this.send<{ result?: { value?: T }; exceptionDetails?: { exception?: { description?: string }; text?: string } }>("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description?.split("\n")[0] ?? r.exceptionDetails.text ?? "the page script failed");
    return r.result?.value as T;
  }

  /** Runs a function on one element and gives back what it returns. */
  async onElement<T>(ref: Ref, fn: string, args: unknown[] = []): Promise<T> {
    try {
      const { object } = await this.send<{ object: { objectId: string } }>("DOM.resolveNode", { backendNodeId: ref.node }, ref.place?.session);
      const r = await this.send<{ result?: { value?: T }; exceptionDetails?: { exception?: { description?: string } } }>("Runtime.callFunctionOn", { objectId: object.objectId, functionDeclaration: fn, arguments: args.map((value) => ({ value })), returnByValue: true, awaitPromise: true }, ref.place?.session);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description?.split("\n")[0] ?? "the page script failed");
      return r.result?.value as T;
    } catch (e) { if (e instanceof Error && GONE.test(e.message)) throw new RefError(`control "${ref.name || ref.role}" is no longer on the page.`, "gone"); throw e; }
  }

  /** Reads the page again: new numbers, and the old ones are void. */
  async read(): Promise<string> {
    const urls = new Map<string, string>();
    const collect = (t: { frame: { id: string; url: string }; childFrames?: any[] }): void => { urls.set(t.frame.id, t.frame.url); for (const c of t.childFrames ?? []) collect(c); };
    await this.send<{ frameTree: any }>("Page.getFrameTree").then((r) => { if (r.frameTree) collect(r.frameTree); }, (e: unknown) => { if (e instanceof DialogOpen) throw e; });
    const { lines, refs } = readTree(await this.#document(undefined, undefined, undefined, 0, { left: MOST_FRAMES }, urls));
    const m = await this.eval<{ t: string; u: string; y: number; h: number; v: number }>("({ t: document.title, u: location.href, y: Math.round(scrollY), h: document.documentElement.scrollHeight, v: innerHeight })");
    this.refs = refs;
    this.stale = "";
    this.title = m.t;
    this.url = m.u;
    const left = Math.max(0, m.h - m.v - m.y);
    this.reading = `Page: ${m.t || "(no title)"}\nAddress: ${m.u}\n${m.h > m.v ? `Scrolled ${m.y} of ${Math.max(0, m.h - m.v)} px${left > 0 ? "; more below" : ""}\n` : ""}\n${lines.join("\n") || "(nothing on this page)"}`;
    return this.reading;
  }

  /** One document of the page (the page's own, a frame's) and the documents of the frames inside it. A frame that cannot be read is left out, and said so. */
  async #document(session: string | undefined, frameId: string | undefined, place: Place | undefined, depth: number, budget: { left: number }, urls: Map<string, string>): Promise<Doc> {
    const { nodes } = await this.send<{ nodes: AxNode[] }>("Accessibility.getFullAXTree", frameId ? { frameId } : {}, session);
    const doc: Doc = { nodes, frames: new Map(), ...(place ? { place } : {}) };
    if (depth >= MOST_DEPTH) return doc;
    for (const n of nodes) {
      if (!FRAME_ROLES.has(String(n.role?.value)) || n.backendDOMNodeId === undefined || budget.left <= 0) continue;
      budget.left--;
      try {
        const described = await this.send<{ node?: { frameId?: string } }>("DOM.describeNode", { backendNodeId: n.backendDOMNodeId }, session);
        const id = described.node?.frameId;
        if (!id) continue;
        const apart = this.#frames.get(id);
        const inner = apart ? { session: apart, owner: { place, node: n.backendDOMNodeId } } : place;
        const child = await this.#document(apart ?? session, apart ? undefined : id, inner, depth + 1, budget, urls);
        const url = urls.get(id) ?? (await this.cdp.send<{ targetInfo?: { url?: string } }>("Target.getTargetInfo", { targetId: id }).catch(() => undefined))?.targetInfo?.url;
        if (url) child.url = url;
        doc.frames.set(n.backendDOMNodeId, child);
      } catch (e) { if (e instanceof DialogOpen) throw e; }
    }
    return doc;
  }

  /** The control a number stands for. The browser is asked something first: what it said about the page before this moment has reached us by then. */
  async ref(n: number): Promise<Ref> {
    await this.send("Runtime.evaluate", { expression: "0" });
    if (this.stale) throw new RefError(`the page went to ${this.stale} since the numbers were given, so they no longer apply. Nothing was done.`, "page-changed");
    const r = this.refs.get(n);
    if (!r) throw new RefError(this.refs.size ? `there is no control ${n} on this page now.` : "no controls have been numbered yet.", this.refs.size ? "unknown" : "unnumbered");
    return r;
  }

  /** Where a control is in the window: scrolled into view, and counted from the window's corner even when it sits in a frame the browser runs apart. Nothing when it has no box. */
  async point(ref: Ref): Promise<Point | undefined> {
    const b = await this.box(ref);
    return b && { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  }

  /** The box a control fills in the window, by the same count as `point`. */
  async box(ref: Ref): Promise<{ x: number; y: number; width: number; height: number } | undefined> {
    const quad = async (node: number, session: string | undefined): Promise<number[] | undefined> => {
      const q = (await this.send<{ quads: number[][] }>("DOM.getContentQuads", { backendNodeId: node }, session).catch((e: unknown) => { if (e instanceof DialogOpen || (e instanceof Error && GONE.test(e.message))) throw e; return { quads: [] as number[][] }; })).quads[0];
      return q && q.length >= 8 ? q : undefined;
    };
    const scroll = (node: number, session: string | undefined): Promise<unknown> => this.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: node }, session).catch((e: unknown) => { if (e instanceof DialogOpen) throw e; });
    await scroll(ref.node, ref.place?.session);
    for (let p = ref.place; p; p = p.owner.place) await scroll(p.owner.node, p.owner.place?.session);
    const q = await quad(ref.node, ref.place?.session);
    if (!q) return undefined;
    const xs = [q[0]!, q[2]!, q[4]!, q[6]!], ys = [q[1]!, q[3]!, q[5]!, q[7]!];
    let x = Math.min(...xs), y = Math.min(...ys);
    const width = Math.max(1, Math.max(...xs) - x), height = Math.max(1, Math.max(...ys) - y);
    for (let p = ref.place; p; p = p.owner.place) {
      const o = await quad(p.owner.node, p.owner.place?.session);
      if (!o) return undefined;
      x += Math.min(o[0]!, o[2]!, o[4]!, o[6]!); y += Math.min(o[1]!, o[3]!, o[5]!, o[7]!);
    }
    return { x, y, width, height };
  }

  /** A place in the last picture of the window as a place in the window; nothing when it is outside the picture. Before any picture, a place is taken as it is. */
  fromShot(x: number, y: number): Point | undefined {
    const s = this.shot;
    if (!s) return { x, y };
    if (!(x >= 0 && y >= 0 && x <= s.width && y <= s.height)) return undefined;
    return { x: (x * s.cssWidth) / s.width, y: (y * s.cssHeight) / s.height };
  }

  #mouse(type: string, p: Point, extra: Record<string, unknown> = {}): Promise<unknown> { return this.send("Input.dispatchMouseEvent", { type, x: p.x, y: p.y, ...extra }); }

  /** A click on a control; one with no box is clicked by the page's own call. */
  async click(ref: Ref): Promise<void> {
    try {
      const p = await this.point(ref);
      if (!p) { await this.onElement(ref, "function () { this.click(); }"); return; }
      await this.clickAt(p);
    } catch (e) { if (e instanceof Error && GONE.test(e.message)) throw new RefError(`control "${ref.name || ref.role}" is no longer on the page.`, "gone"); throw e; }
  }

  async clickAt(p: Point): Promise<void> {
    await this.#mouse("mouseMoved", p);
    await this.#mouse("mousePressed", p, { button: "left", clickCount: 1 });
    await this.#mouse("mouseReleased", p, { button: "left", clickCount: 1 });
  }

  hoverAt(p: Point): Promise<unknown> { return this.#mouse("mouseMoved", p); }

  /**
   * Presses at `from`, moves in steps and lets go at `to`. A page that drags with the mouse alone sees exactly that. A page that uses the
   * browser's own drag and drop is held back by the browser at the first move, so the drag is carried through by hand with what it holds.
   */
  async dragBetween(from: Point, to: Point): Promise<void> {
    this.dragData = undefined;
    await this.send("Input.setInterceptDrags", { enabled: true }).catch((e: unknown) => { if (e instanceof DialogOpen) throw e; });
    try {
      await this.#mouse("mouseMoved", from);
      await this.#mouse("mousePressed", from, { button: "left", clickCount: 1 });
      for (const t of [0.25, 0.5, 0.75, 1]) await this.#mouse("mouseMoved", { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t }, { button: "left", buttons: 1 });
      if (this.dragData) for (const type of ["dragEnter", "dragOver", "drop"]) await this.send("Input.dispatchDragEvent", { type, x: to.x, y: to.y, data: this.dragData });
      await this.#mouse("mouseReleased", to, { button: "left", clickCount: 1 });
    } finally { await this.send("Input.setInterceptDrags", { enabled: false }).catch(() => undefined); }
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
    this.#refusals.clear();
    this.#documents.clear();
    this.#documents.add(hostOf(url));
    const ask = async (): Promise<string | undefined> => (await this.send<{ errorText?: string }>("Page.navigate", { url })).errorText;
    const error = await openWithRetry(ask).catch((e: unknown) => { throw e instanceof Error && TOOK_TOO_LONG.test(e.message) ? new Error(`${e.message}; ${stillWaitedFor(this.#urls.values())}`) : e; });
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
