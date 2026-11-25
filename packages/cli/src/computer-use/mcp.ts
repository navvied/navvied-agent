/** A minimal Model Context Protocol client over line-delimited JSON-RPC, for the one server this host talks to. No dependencies. */
export interface Wire {
  write(line: string): void;
  onLine(fn: (line: string) => void): void;
  onClose(fn: () => void): void;
}

export interface Tool { name: string; inputSchema?: { properties?: Record<string, unknown> } }
export interface CallResult { isError: boolean; text: string; structured?: unknown; image?: { mime: string; data: string } }

/** The call was sent and no answer came: whether it landed is not known, so the caller must never send it again. */
export class OutcomeUnknown extends Error { constructor(why: string) { super(why); this.name = "OutcomeUnknown"; } }
/** The server was not reached or refused before doing anything: the call certainly did not happen. */
export class NotSent extends Error { constructor(why: string) { super(why); this.name = "NotSent"; } }

type Waiting = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

export class McpClient {
  private next = 1;
  private waiting = new Map<number, Waiting>();
  private closed = false;

  constructor(private wire: Wire, private clientName = "navvied") {
    wire.onLine((line) => this.receive(line));
    wire.onClose(() => this.fail(new OutcomeUnknown("The driver stopped.")));
  }

  private receive(line: string): void {
    let msg: { id?: number; result?: unknown; error?: { message?: string } };
    try { msg = JSON.parse(line); } catch { return; }
    if (typeof msg.id !== "number") return;
    const w = this.waiting.get(msg.id);
    if (!w) return;
    this.waiting.delete(msg.id); clearTimeout(w.timer);
    if (msg.error) w.reject(new Error(msg.error.message ?? "The driver refused the request."));
    else w.resolve(msg.result);
  }

  private fail(e: Error): void {
    this.closed = true;
    for (const [id, w] of this.waiting) { clearTimeout(w.timer); w.reject(e); this.waiting.delete(id); }
  }

  /** `sent` tells the caller, when the request fails, whether the server could have acted on it. */
  private request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.closed) return Promise.reject(new NotSent("The driver is not running."));
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiting.delete(id); reject(new OutcomeUnknown("The driver did not answer in time.")); }, timeoutMs);
      this.waiting.set(id, { resolve, reject, timer });
      try { this.wire.write(JSON.stringify({ jsonrpc: "2.0", id, method, params })); } catch { this.waiting.delete(id); clearTimeout(timer); reject(new NotSent("The driver is not running.")); }
    });
  }

  async initialize(timeoutMs = 10_000): Promise<void> {
    await this.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: this.clientName, version: "1" } }, timeoutMs);
    this.wire.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
  }

  async tools(timeoutMs = 10_000): Promise<Tool[]> {
    const r = (await this.request("tools/list", {}, timeoutMs)) as { tools?: Tool[] };
    return r.tools ?? [];
  }

  async call(name: string, args: Record<string, unknown>, timeoutMs = 30_000): Promise<CallResult> {
    const r = (await this.request("tools/call", { name, arguments: args }, timeoutMs)) as {
      isError?: boolean; structuredContent?: unknown; content?: { type: string; text?: string; data?: string; mimeType?: string }[];
    };
    const parts = r.content ?? [];
    const image = parts.find((p) => p.type === "image" && p.data);
    return {
      isError: r.isError === true,
      text: parts.filter((p) => p.type === "text").map((p) => p.text ?? "").join("\n"),
      ...(r.structuredContent !== undefined ? { structured: r.structuredContent } : {}),
      ...(image ? { image: { mime: image.mimeType ?? "image/png", data: image.data! } } : {}),
    };
  }
}
