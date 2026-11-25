/**
 * One connection to a browser's DevTools endpoint: commands go out with an id and come back by it, and what the browser reports on its
 * own (a dialog opened, a page navigated) is handed to whoever listens for that name. It knows nothing about pages.
 */

const CALL_MS = 30_000;

interface Pending { resolve(v: unknown): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout> }
export type Listener = (params: Record<string, any>, sessionId: string | undefined) => void;

export class Cdp {
  #next = 1;
  #pending = new Map<number, Pending>();
  #listeners = new Map<string, Set<Listener>>();
  #onClose = new Set<() => void>();
  closed = false;

  private constructor(private readonly socket: WebSocket) {
    socket.onmessage = (m) => this.#message(String(m.data));
    socket.onclose = () => this.close();
  }

  static async connect(url: string): Promise<Cdp> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = () => reject(new Error("could not connect to the browser")); });
    return new Cdp(socket);
  }

  on(method: string, fn: Listener): () => void {
    let set = this.#listeners.get(method);
    if (!set) this.#listeners.set(method, (set = new Set()));
    set.add(fn);
    return () => set.delete(fn);
  }

  onClose(fn: () => void): void { this.#onClose.add(fn); }

  #message(text: string): void {
    let m: { id?: number; method?: string; params?: Record<string, any>; sessionId?: string; result?: unknown; error?: { message?: string } };
    try { m = JSON.parse(text); } catch { return; }
    if (m.method) { for (const fn of this.#listeners.get(m.method) ?? []) { try { fn(m.params ?? {}, m.sessionId); } catch { /* a listener's failure is not the connection's */ } } return; }
    if (typeof m.id !== "number") return;
    const p = this.#pending.get(m.id);
    if (!p) return;
    this.#pending.delete(m.id);
    clearTimeout(p.timer);
    if (m.error) p.reject(new Error(m.error.message ?? "the browser reported an error")); else p.resolve(m.result);
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = CALL_MS): Promise<T> {
    return new Promise((resolve, reject) => {
      if (this.closed) { reject(new Error("the browser is closed")); return; }
      const id = this.#next++;
      const timer = setTimeout(() => { this.#pending.delete(id); reject(new Error(`${method} took too long`)); }, timeoutMs);
      this.#pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.#pending.values()) { clearTimeout(p.timer); p.reject(new Error("the browser was closed")); }
    this.#pending.clear();
    try { this.socket.close(); } catch { /* already closed */ }
    for (const fn of this.#onClose) fn();
  }
}
