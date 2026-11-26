import { existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { BrowserNote } from "@navvied/protocol";
import { refusal } from "../web-guard.ts";
import { Cdp } from "./cdp.ts";
import { startGuardProxy, type GuardProxy } from "./guard-proxy.ts";
import { launch, type Launched } from "./launch.ts";
import { Tab } from "./tab.ts";

const IDLE_MS = 5 * 60_000;
const MOST_DOWNLOAD = 500 * 1024 * 1024;
const TAB_EVENTS = ["Page.javascriptDialogOpening", "Page.javascriptDialogClosed", "Page.fileChooserOpened", "Page.frameNavigated", "Runtime.consoleAPICalled", "Runtime.exceptionThrown", "Network.requestWillBeSent", "Network.loadingFinished", "Network.loadingFailed", "Network.responseReceived", "Fetch.requestPaused", "Input.dragIntercepted"];

export interface Download { guid: string; url: string; name: string; state: "going" | "done" | "failed"; path?: string; bytes?: number; note?: string; told?: true }

interface PageToCome { promise: Promise<Tab>; resolve(t: Tab): void; reject(why: Error): void }

function pageToCome(): PageToCome {
  let resolve!: (t: Tab) => void, reject!: (why: Error) => void;
  const promise = new Promise<Tab>((yes, no) => { resolve = yes; reject = no; });
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

export class Session {
  cdp!: Cdp;
  tabs: Tab[] = [];
  current!: Tab;
  closed = false;
  /** Whether this computer may be sent to local and private addresses (the host's choice, set at each call). */
  allowPrivate = false;
  /** Pages the browser opened by itself since they were last reported (a link that opens a new window). */
  opened: Tab[] = [];
  downloads: Download[] = [];
  /** Where what the browser saw happen is told (the step that is running; set at each call). */
  say: ((note: BrowserNote) => void) | undefined;
  #proxy: GuardProxy | undefined;
  #launched: Launched | undefined;
  #idle: ReturnType<typeof setTimeout> | undefined;
  #byId = new Map<string, Tab>();
  #waiting = new Map<string, PageToCome>();
  #own = new Set<string>();
  #folder = "";
  #downloadWaiters = new Set<() => void>();

  /** Starts the browser, or connects to the one at `NAVVIED_BROWSER_ENDPOINT` (a DevTools address; for tests and for a browser that is run by hand). */
  static async open(chrome: string | undefined): Promise<Session> {
    const s = new Session();
    const endpoint = process.env.NAVVIED_BROWSER_ENDPOINT;
    try {
      if (endpoint) { s.cdp = await Cdp.connect(endpoint); }
      else {
        s.#proxy = startGuardProxy(() => s.allowPrivate, (why, host) => { for (const t of s.tabs) t.refuse(host.toLowerCase(), why); });
        s.#launched = await launch(chrome!, s.#proxy.port);
        s.cdp = await Cdp.connect(s.#launched.endpoint);
      }
      s.cdp.onClose(() => s.close());
      await s.#setUp();
    } catch (e) { s.close(); throw e; }
    s.touch();
    return s;
  }

  async #setUp(): Promise<void> {
    for (const name of TAB_EVENTS) this.cdp.on(name, (p, sid) => { if (sid) this.#byId.get(sid)?.handle(name, p, sid); });
    this.cdp.on("Target.attachedToTarget", (p, sid) => {
      if (p.targetInfo?.type === "page") { const id = String(p.targetInfo.targetId); void this.#adopt(String(p.sessionId), id, p.targetInfo.openerId ? String(p.targetInfo.openerId) : undefined).catch((e: Error) => this.#couldNotBeSetUp(id, e)); }
      // A frame of another site speaks through a session of its own; it belongs to the page that holds it.
      else if (p.targetInfo?.type === "iframe" && sid) { const tab = this.#byId.get(sid); if (tab) { this.#byId.set(String(p.sessionId), tab); void tab.attachFrame(String(p.sessionId), String(p.targetInfo.targetId)); } }
    });
    this.cdp.on("Target.detachedFromTarget", (p) => { const id = String(p.sessionId); const tab = this.#byId.get(id); if (tab && id !== tab.sessionId) { tab.detachFrame(id); this.#byId.delete(id); } });
    this.cdp.on("Target.targetInfoChanged", (p) => { const t = this.tabs.find((x) => x.targetId === p.targetInfo?.targetId); if (t) { t.title = String(p.targetInfo.title ?? ""); t.url = String(p.targetInfo.url ?? t.url); } });
    this.cdp.on("Target.targetDestroyed", (p) => this.#gone(String(p.targetId)));
    this.cdp.on("Browser.downloadWillBegin", (p) => { mkdirSync(this.#folder, { recursive: true }); this.downloads.push({ guid: String(p.guid), url: String(p.url ?? ""), name: String(p.suggestedFilename || "download"), state: "going" }); this.say?.({ what: "download", state: "started", name: this.downloads.at(-1)!.name }); });
    this.cdp.on("Browser.downloadProgress", (p) => this.#progress(p));
    await this.cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    const { targetInfos } = await this.cdp.send<{ targetInfos: { targetId: string; type: string }[] }>("Target.getTargets");
    const first = targetInfos.find((t) => t.type === "page");
    this.current = first ? await Promise.race([this.#tabFor(first.targetId), new Promise<Tab>((_, no) => setTimeout(() => no(new Error("the browser did not show its first page")), 10_000))]) : await this.newTab();
    this.#own.add(this.current.targetId);
  }

  #tabFor(targetId: string): Promise<Tab> {
    const existing = this.tabs.find((t) => t.targetId === targetId);
    return existing ? Promise.resolve(existing) : this.#toCome(targetId).promise;
  }

  #toCome(targetId: string): PageToCome {
    let page = this.#waiting.get(targetId);
    if (!page) { page = pageToCome(); this.#waiting.set(targetId, page); }
    return page;
  }

  #couldNotBeSetUp(targetId: string, why: Error): void {
    this.#toCome(targetId).reject(why);
    this.current?.failures.push(`a new tab was left out: ${why.message}`);
  }

  async #adopt(sessionId: string, targetId: string, opener: string | undefined): Promise<Tab> {
    const tab = new Tab(this.cdp, targetId, sessionId, async (url) => this.#gate(url), (note) => this.say?.(note));
    this.#byId.set(sessionId, tab);
    await tab.init();
    this.tabs.push(tab);
    if (opener && !this.#own.has(targetId) && this.tabs.some((t) => t.targetId === opener)) { this.opened.push(tab); this.current = tab; }
    this.#waiting.get(targetId)?.resolve(tab);
    return tab;
  }

  #gone(targetId: string): void {
    const tab = this.tabs.find((t) => t.targetId === targetId);
    if (!tab) return;
    this.tabs = this.tabs.filter((t) => t !== tab);
    this.#byId.delete(tab.sessionId);
    this.opened = this.opened.filter((t) => t !== tab);
    if (this.current === tab && this.tabs.length) this.current = this.tabs[this.tabs.length - 1]!;
  }

  /** A request the page makes is let through, or failed, by the same look as the web tools make of an address; only addresses of the network are looked at. */
  async #gate(address: string): Promise<string | undefined> {
    try {
      const url = new URL(address);
      if (url.protocol === "file:") return "files on this computer are not opened.";
      return url.protocol === "http:" || url.protocol === "https:" ? await refusal(url, this.allowPrivate) : undefined;
    } catch { return "the address could not be read, so it was not loaded."; }
  }

  async newTab(url = "about:blank"): Promise<Tab> {
    const { targetId } = await this.cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
    this.#own.add(targetId);
    const tab = await this.#tabFor(targetId);
    this.current = tab;
    if (url !== "about:blank") await tab.navigate(url);
    return tab;
  }

  async closeTab(tab: Tab): Promise<void> {
    await this.cdp.send("Target.closeTarget", { targetId: tab.targetId }).catch(() => undefined);
    this.#gone(tab.targetId);
    if (!this.tabs.length) await this.newTab();
  }

  async list(): Promise<{ n: number; title: string; url: string; current: boolean }[]> {
    const r = await this.cdp.send<{ targetInfos: { targetId: string; title: string; url: string }[] }>("Target.getTargets").catch(() => undefined);
    return this.tabs.map((t, i) => { const info = r?.targetInfos.find((x) => x.targetId === t.targetId); return { n: i + 1, title: info?.title ?? t.title, url: info?.url ?? t.url, current: t === this.current }; });
  }

  /** Downloads go to this folder; set before anything that may start one. */
  async downloadsTo(folder: string): Promise<void> {
    if (folder === this.#folder) return;
    await this.cdp.send("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: folder, eventsEnabled: true });
    this.#folder = folder;
  }

  #progress(p: Record<string, any>): void {
    const d = this.downloads.find((x) => x.guid === p.guid);
    if (!d) return;
    d.bytes = Number(p.receivedBytes ?? 0);
    if (d.state === "going" && d.bytes > MOST_DOWNLOAD) { d.state = "failed"; d.note = "stopped: larger than 500 MB"; void this.cdp.send("Browser.cancelDownload", { guid: d.guid }).catch(() => undefined); }
    if (p.state === "completed" && d.state === "going") {
      const safe = basename(d.name).replace(/[^\w.\- ()]/g, "_").replace(/^\.+/, "") || "download";
      let target = join(this.#folder, safe);
      for (let i = 1; existsSync(target); i++) target = join(this.#folder, `${basename(safe, extname(safe))} (${i})${extname(safe)}`);
      try { renameSync(join(this.#folder, d.guid), target); d.path = target; d.bytes = statSync(target).size; d.state = "done"; } catch (e) { d.state = "failed"; d.note = e instanceof Error ? e.message : "the file could not be kept"; }
    } else if (p.state === "canceled" && d.state === "going") { d.state = "failed"; d.note = "cancelled"; }
    if (d.state !== "going") {
      if (!d.told) { d.told = true; this.say?.({ what: "download", state: d.state, name: basename(d.path ?? d.name), ...(d.bytes !== undefined ? { bytes: d.bytes } : {}), ...(d.path ? { path: d.path } : {}), ...(d.note ? { note: d.note } : {}) }); }
      for (const w of this.#downloadWaiters) w();
    }
  }

  /** Waits for the downloads that began after `from` to end, for at most `ms`; the ones that did not end say so. */
  async downloaded(from: number, ms: number): Promise<Download[]> {
    const mine = (): Download[] => this.downloads.slice(from);
    if (!mine().length) return [];
    await new Promise<void>((resolve) => {
      const check = (): void => { if (mine().every((d) => d.state !== "going")) { clearTimeout(t); this.#downloadWaiters.delete(check); resolve(); } };
      const t = setTimeout(() => { this.#downloadWaiters.delete(check); resolve(); }, ms);
      this.#downloadWaiters.add(check);
      check();
    });
    return mine();
  }

  touch(): void { clearTimeout(this.#idle); this.#idle = setTimeout(() => this.close(), IDLE_MS); this.#idle.unref?.(); }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.#idle);
    this.cdp?.close();
    this.#proxy?.close();
    this.#launched?.stop();
  }
}
