import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AxNode } from "../src/tools/browser/ax.ts";

/**
 * A stand-in for a browser's DevTools endpoint: it answers the commands the browser tool sends from a small model of pages, and sends the
 * events a real browser would (a page navigated, a dialog opened, a download began). Nothing here needs a browser on the computer.
 */

export type Spec = [role: string, name: string, props?: { node?: number; url?: string; checked?: boolean | string; value?: string; level?: number; focusable?: boolean; ignored?: boolean; disabled?: boolean }, children?: Spec[]];

/** An accessibility tree from a nested description. Controls need a `node` (the browser's own id for the element). */
export function tree(root: Spec[]): AxNode[] {
  const nodes: AxNode[] = [];
  let next = 1;
  const add = (s: Spec): string => {
    const id = String(next++);
    const [role, name, p = {}, kids = []] = s;
    const node: AxNode = { nodeId: id, role: { value: role }, name: { value: name }, properties: [] };
    if (p.node !== undefined) node.backendDOMNodeId = p.node;
    if (p.ignored) node.ignored = true;
    if (p.value !== undefined) node.value = { value: p.value };
    if (p.url) node.properties!.push({ name: "url", value: { value: p.url } });
    if (p.checked !== undefined) node.properties!.push({ name: "checked", value: { value: String(p.checked) } });
    if (p.level) node.properties!.push({ name: "level", value: { value: p.level } });
    if (p.focusable) node.properties!.push({ name: "focusable", value: { value: true } });
    if (p.disabled) node.properties!.push({ name: "disabled", value: { value: true } });
    nodes.push(node);
    const childIds = kids.map(add);
    if (childIds.length) node.childIds = childIds;
    return id;
  };
  const ids = root.map(add);
  nodes.unshift({ nodeId: "0", role: { value: "RootWebArea" }, name: { value: "" }, childIds: ids });
  return nodes;
}

export interface Site { title: string; ax: Spec[]; /** What the page's own scripts answer, by what is asked (see `answers`). */ challenge?: "captcha" | "code"; errorText?: string; password?: number[]; text?: string }
export interface FakePage { targetId: string; sessionId: string; url: string; title: string; ax: AxNode[]; history: string[]; at: number; blocked: boolean; opener?: string; gone: Set<number>; site?: Site }
export interface Seen { method: string; params: Record<string, any>; sessionId?: string }

const JPEG = "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=";

export class FakeBrowser {
  readonly server: ReturnType<typeof Bun.serve>;
  readonly endpoint: string;
  pages = new Map<string, FakePage>();
  sites = new Map<string, Site>();
  seen: Seen[] = [];
  /** What the page's controls do when clicked, by the browser's id for the element. */
  onClick = new Map<number, (page: FakePage, fake: FakeBrowser) => void>();
  /** The values typed into elements. */
  typed = new Map<number, string>();
  /** What the page's script answers to a command it was sent as text, when the built-in answers do not cover it. */
  answers: (expression: string, page: FakePage) => unknown = () => undefined;
  /** Called before a function runs on an element (a page that moves at that moment). */
  beforeFunction: (fn: string) => void = () => {};
  folder = "";
  #ws: { send(data: string): void } | undefined;
  #held: { id: number; answer: () => unknown }[] = [];
  #targets = 0;
  /** Commands the fake leaves unanswered until `release` (a page that is stuck). */
  hold = new Set<string>();

  constructor() {
    const self = this;
    this.server = Bun.serve<undefined>({
      port: 0,
      fetch(req, server) { return server.upgrade(req, { data: undefined }) ? undefined : new Response("not a browser"); },
      websocket: {
        open(ws) { self.#ws = ws; },
        message(_ws, data) { self.#handle(JSON.parse(String(data))); },
        close() { self.#ws = undefined; },
      },
    });
    this.endpoint = `ws://127.0.0.1:${this.server.port}/devtools/browser/fake`;
  }

  stop(): void { this.server.stop(true); }
  site(url: string, s: Site): void { this.sites.set(url, s); }
  calls(method: string): Seen[] { return this.seen.filter((s) => s.method === method); }
  event(method: string, params: Record<string, unknown>, sessionId?: string): void { this.#ws?.send(JSON.stringify({ method, params, ...(sessionId ? { sessionId } : {}) })); }
  page(n = 0): FakePage { return [...this.pages.values()][n]!; }

  addPage(url = "about:blank", opener?: string): FakePage {
    const id = `T${++this.#targets}`;
    const p: FakePage = { targetId: id, sessionId: `S${this.#targets}`, url, title: "", ax: tree([]), history: [url], at: 0, blocked: false, gone: new Set(), ...(opener ? { opener } : {}) };
    this.pages.set(id, p);
    this.event("Target.attachedToTarget", { sessionId: p.sessionId, waitingForDebugger: true, targetInfo: { targetId: id, type: "page", url, ...(opener ? { openerId: opener } : {}) } });
    return p;
  }

  /** A dialog opens on the page: it holds everything the page is asked until it is answered. */
  openDialog(page: FakePage, type: string, message: string, defaultPrompt = ""): void {
    page.blocked = true;
    this.event("Page.javascriptDialogOpening", { url: page.url, message, type, defaultPrompt }, page.sessionId);
  }

  popup(from: FakePage, url: string): FakePage {
    const p = this.addPage("about:blank", from.targetId);
    this.#load(p, url);
    return p;
  }

  /** A download begins and ends, as the browser says it: the file is named by its guid in the folder it was told. */
  download(guid: string, name: string, content: string, url = "http://example.test/file"): void {
    this.event("Browser.downloadWillBegin", { guid, url, suggestedFilename: name });
    mkdirSync(this.folder, { recursive: true });
    writeFileSync(join(this.folder, guid), content);
    this.event("Browser.downloadProgress", { guid, totalBytes: content.length, receivedBytes: content.length, state: "completed" });
  }

  /** A command that was held is answered. */
  release(): void { const held = this.#held; this.#held = []; for (const h of held) this.#reply(h.id, h.answer() ?? {}); }

  /** The page goes to another address by itself (a link was followed, a script moved it). */
  goto(p: FakePage, url: string): void { p.history = [...p.history.slice(0, p.at + 1), url]; p.at = p.history.length - 1; this.#load(p, url); }

  #load(p: FakePage, url: string): void {
    const site = this.sites.get(url);
    p.url = url; p.site = site; p.title = site?.title ?? ""; p.ax = tree(site?.ax ?? []); p.gone.clear();
    this.event("Page.frameNavigated", { frame: { id: "main", url } }, p.sessionId);
    this.event("Target.targetInfoChanged", { targetInfo: { targetId: p.targetId, title: p.title, url } });
  }

  #reply(id: number, result: unknown, error?: string): void { this.#ws?.send(JSON.stringify(error ? { id, error: { message: error } } : { id, result })); }

  #handle(m: { id: number; method: string; params: Record<string, any>; sessionId?: string }): void {
    this.seen.push({ method: m.method, params: m.params, ...(m.sessionId ? { sessionId: m.sessionId } : {}) });
    const page = [...this.pages.values()].find((p) => p.sessionId === m.sessionId);
    if (m.method !== "Page.handleJavaScriptDialog" && (page?.blocked || this.hold.has(m.method))) { this.#held.push({ id: m.id, answer: () => this.#run(m.method, m.params, m.sessionId) }); return; }
    try {
      const r = this.#run(m.method, m.params, m.sessionId);
      // A click that opened a dialog does not return until the dialog is answered.
      if (page?.blocked && m.method === "Input.dispatchMouseEvent") this.#held.push({ id: m.id, answer: () => r });
      else this.#reply(m.id, r ?? {});
      if (m.method === "Target.setAutoAttach") queueMicrotask(() => {
        if (!this.pages.size) this.addPage();
        else for (const x of this.pages.values()) this.event("Target.attachedToTarget", { sessionId: x.sessionId, waitingForDebugger: true, targetInfo: { targetId: x.targetId, type: "page", url: x.url } });
      });
    } catch (e) { this.#reply(m.id, undefined, e instanceof Error ? e.message : String(e)); }
  }

  #run(method: string, p: Record<string, any>, sessionId?: string): unknown {
    const page = [...this.pages.values()].find((x) => x.sessionId === sessionId);
    switch (method) {
      case "Target.getTargets": return { targetInfos: [...this.pages.values()].map((x) => ({ targetId: x.targetId, type: "page", title: x.title, url: x.url })) };
      case "Target.createTarget": { const x = this.addPage(); return { targetId: x.targetId }; }
      case "Target.closeTarget": { this.pages.delete(p.targetId); this.event("Target.targetDestroyed", { targetId: p.targetId }); return { success: true }; }
      case "Browser.setDownloadBehavior": this.folder = p.downloadPath; return {};
      case "Page.navigate": {
        const site = this.sites.get(p.url);
        if (site?.errorText) return { errorText: site.errorText };
        page!.history = [...page!.history.slice(0, page!.at + 1), p.url]; page!.at = page!.history.length - 1;
        this.#load(page!, p.url);
        return { frameId: "main" };
      }
      case "Page.getNavigationHistory": return { currentIndex: page!.at, entries: page!.history.map((url, id) => ({ id, url })) };
      case "Page.navigateToHistoryEntry": page!.at = p.entryId; this.#load(page!, page!.history[p.entryId]!); return {};
      case "Page.handleJavaScriptDialog": { page!.blocked = false; this.event("Page.javascriptDialogClosed", { result: p.accept }, page!.sessionId); queueMicrotask(() => this.release()); return {}; }
      case "Page.captureScreenshot": return { data: JPEG };
      case "Accessibility.getFullAXTree": return { nodes: page!.ax };
      case "DOM.resolveNode": if (page!.gone.has(p.backendNodeId)) throw new Error("No node with given id found"); return { object: { objectId: `node-${p.backendNodeId}` } };
      case "DOM.getContentQuads": { const n = p.backendNodeId; if (page!.gone.has(n)) throw new Error("Could not find node with given id"); return { quads: [[n * 100, 0, n * 100 + 50, 0, n * 100 + 50, 20, n * 100, 20]] }; }
      case "DOM.setFileInputFiles": return {};
      case "Input.dispatchMouseEvent":
        if (p.type === "mouseReleased") this.onClick.get(Math.floor(p.x / 100))?.(page!, this);
        return {};
      case "Runtime.callFunctionOn": {
        const node = Number(String(p.objectId).replace("node-", ""));
        this.beforeFunction(String(p.functionDeclaration));
        const fn = String(p.functionDeclaration), args = (p.arguments ?? []).map((a: any) => a.value);
        if (fn.includes("password")) return { result: { value: { password: page!.site?.password?.includes(node) ?? false, origin: new URL(page!.url).origin } } };
        if (fn.includes("expected")) { if (args[0] !== new URL(page!.url).origin) return { result: { value: "moved" } }; this.typed.set(node, args[1]); return { result: { value: "ok" } }; }
        if (fn.includes("this.options")) return { result: { value: args[0] === "none" ? "none" : "ok" } };
        return { result: { value: true } };
      }
      case "Runtime.evaluate": return { result: { value: this.#evaluate(String(p.expression), page!) } };
      default: return {};
    }
  }

  #evaluate(x: string, page: FakePage): unknown {
    if (x === "document.readyState") return "complete";
    if (x === "location.href") return page.url;
    if (x.includes("t: document.title")) return { t: page.title, u: page.url, y: 0, h: 900, v: 900 };
    if (x.includes("recaptcha")) return page.site?.challenge ?? "";
    const own = this.answers(x, page);
    if (own !== undefined) return own;
    if (x.includes("innerText") && x.includes("includes(")) return (page.site?.text ?? "").toLowerCase().includes(/includes\((".*?")\)/.exec(x) ? JSON.parse(/includes\((".*?")\)/.exec(x)![1]!) : "\u0000");
    return null;
  }
}
