/**
 * A client for MCP servers: programs that give the agent more tools. Each one is started as a child process and spoken to in
 * JSON lines over its standard input and output. Its tools join the engine's own, named `mcp__<server>__<tool>`.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { killTree, usesProcessGroups } from "./platform.ts";
import type { Tool } from "./types.ts";
import { clip } from "./tools/util.ts";

/** A server is either a program started here (`command`) or one reached over the web (`url`, with the headers it wants, such as a token). */
export interface McpServerConfig {
  command?: string;
  url?: string;
  headers?: Record<string, string>;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean };
}

const PROTOCOL = "2025-03-26";
const HANDSHAKE_MS = 15_000;
const CALL_MS = 120_000;
const NAME = /[^A-Za-z0-9_-]/g;

type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };

/** What the engine needs from a server, however it is reached. */
export interface McpLike {
  readonly name: string;
  tools(): Promise<McpToolInfo[]>;
  call(tool: string, args: Record<string, unknown>, signal: AbortSignal): Promise<string>;
  close(): void;
}

const resultText = (result: { content?: { type: string; text?: string }[]; isError?: boolean }): string => {
  const body = (result.content ?? []).map((c) => (c.type === "text" ? c.text ?? "" : `[${c.type} omitted]`)).join("\n").trim();
  return result.isError ? `Error: ${body || "the tool reported a failure"}` : body || "(no output)";
};

/**
 * A server reached over the web ("streamable HTTP"): every message is a POST, and the answer comes back either as JSON or as an event
 * stream that carries it. The server may give a session id on the first answer, which is sent back from then on.
 */
export class McpHttpClient implements McpLike {
  #session: string | undefined;
  #next = 1;
  #closed = false;

  private constructor(readonly name: string, private readonly url: string, private readonly headers: Record<string, string>) {}

  static async start(name: string, config: McpServerConfig): Promise<McpHttpClient> {
    if (!config.url || !/^https?:\/\//.test(config.url)) throw new Error("the address must start with http:// or https://");
    const client = new McpHttpClient(name, config.url, config.headers ?? {});
    try {
      await client.#request("initialize", { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "navvied", version: "1" } }, HANDSHAKE_MS);
      await client.#post({ jsonrpc: "2.0", method: "notifications/initialized" }, undefined, HANDSHAKE_MS);
      return client;
    } catch (e) { client.close(); throw e; }
  }

  async tools(): Promise<McpToolInfo[]> {
    const listed: McpToolInfo[] = [];
    let cursor: string | undefined;
    do {
      const page = (await this.#request("tools/list", cursor ? { cursor } : {}, HANDSHAKE_MS)) as { tools?: McpToolInfo[]; nextCursor?: string };
      listed.push(...(page.tools ?? []));
      cursor = page.nextCursor;
    } while (cursor && listed.length < 500);
    return listed;
  }

  async call(tool: string, args: Record<string, unknown>, signal: AbortSignal): Promise<string> {
    try { return resultText((await this.#request("tools/call", { name: tool, arguments: args }, CALL_MS, signal)) as never); }
    catch (e) { return `Error: ${signal.aborted ? "[interrupted]" : e instanceof Error ? e.message : String(e)}`; }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#session) void fetch(this.url, { method: "DELETE", headers: { ...this.headers, "mcp-session-id": this.#session }, signal: AbortSignal.timeout(3000) }).catch(() => undefined);
  }

  async #request(method: string, params: unknown, ms: number, signal?: AbortSignal): Promise<unknown> {
    if (this.#closed) throw new Error("the server is not connected");
    const id = this.#next++;
    return this.#post({ jsonrpc: "2.0", id, method, params }, id, ms, signal);
  }

  async #post(message: Record<string, unknown>, id: number | undefined, ms: number, outer?: AbortSignal): Promise<unknown> {
    const stop = AbortSignal.any([AbortSignal.timeout(ms), ...(outer ? [outer] : [])]);
    let res: Response;
    try {
      res = await fetch(this.url, { method: "POST", signal: stop, body: JSON.stringify(message), headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": PROTOCOL, ...(this.#session ? { "mcp-session-id": this.#session } : {}), ...this.headers } });
    } catch (e) { throw new Error(outer?.aborted ? "[interrupted]" : stop.aborted ? `${String(message.method)} took longer than ${Math.round(ms / 1000)} s` : `could not be reached: ${e instanceof Error ? e.message : String(e)}`); }
    const session = res.headers.get("mcp-session-id");
    if (session) this.#session = session;
    if (id === undefined) { await res.body?.cancel().catch(() => undefined); return undefined; }
    if (!res.ok) throw new Error(`the server answered ${res.status}${res.status === 401 || res.status === 403 ? " (check the token in its headers)" : ""}`);
    const reply = (res.headers.get("content-type") ?? "").includes("text/event-stream") ? await this.#fromStream(res, id, stop) : (await res.json()) as unknown;
    const found = (Array.isArray(reply) ? reply : [reply]).find((m) => (m as { id?: unknown }).id === id) as { result?: unknown; error?: { message?: string } } | undefined;
    if (!found) throw new Error("the server did not answer that request");
    if (found.error) throw new Error(found.error.message ?? "the server reported an error");
    return found.result;
  }

  /** Reads an event stream until the answer to `id` has come. */
  async #fromStream(res: Response, id: number, stop: AbortSignal): Promise<unknown> {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (let at = buffer.search(/\r?\n\r?\n/); at >= 0; at = buffer.search(/\r?\n\r?\n/)) {
          const block = buffer.slice(0, at);
          buffer = buffer.slice(at).replace(/^\r?\n\r?\n/, "");
          const data = block.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
          if (!data) continue;
          try { const m = JSON.parse(data) as { id?: unknown }; if (m.id === id) return m; } catch { /* not a message */ }
        }
        if (stop.aborted) break;
      }
    } finally { void reader.cancel().catch(() => undefined); }
    throw new Error("the stream ended without an answer");
  }
}

export class McpClient implements McpLike {
  #child: ChildProcess;
  #next = 1;
  #pending = new Map<number, Pending>();
  #buffer = "";
  #stderr = "";
  #closed = false;

  private constructor(readonly name: string, child: ChildProcess) {
    this.#child = child;
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.#read(chunk));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => { this.#stderr = (this.#stderr + chunk).slice(-2000); });
    child.stdin?.on("error", () => undefined);
    child.on("error", (e) => this.#fail(new Error(`could not start: ${e.message}`)));
    child.on("close", (code) => { if (!this.#closed) this.#fail(new Error(`ended unexpectedly (exit ${code})${this.#detail()}`)); });
  }

  /** Starts the server and completes the handshake, or throws with the reason. */
  static async start(name: string, config: McpServerConfig): Promise<McpClient> {
    if (!config.command) throw new Error("a connected program needs a command or an address");
    const child = spawn(config.command, config.args ?? [], { cwd: config.cwd, env: { ...process.env, ...config.env }, detached: usesProcessGroups(), windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const client = new McpClient(name, child);
    try {
      await client.#request("initialize", { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "navvied", version: "1" } }, HANDSHAKE_MS);
      client.#notify("notifications/initialized");
      return client;
    } catch (e) { client.close(); throw e; }
  }

  async tools(): Promise<McpToolInfo[]> {
    const listed: McpToolInfo[] = [];
    let cursor: string | undefined;
    do {
      const page = (await this.#request("tools/list", cursor ? { cursor } : {}, HANDSHAKE_MS)) as { tools?: McpToolInfo[]; nextCursor?: string };
      listed.push(...(page.tools ?? []));
      cursor = page.nextCursor;
    } while (cursor && listed.length < 500);
    return listed;
  }

  /** Runs one tool and returns its text. A tool that reports failure is returned as an `Error:` line, as the engine's own tools do. */
  async call(tool: string, args: Record<string, unknown>, signal: AbortSignal): Promise<string> {
    const id = this.#next;
    const done = this.#request("tools/call", { name: tool, arguments: args }, CALL_MS);
    const abort = (): void => { this.#notify("notifications/cancelled", { requestId: id, reason: "the user stopped the turn" }); this.#drop(id, new Error("[interrupted]")); };
    signal.addEventListener("abort", abort, { once: true });
    try {
      const result = (await done) as { content?: { type: string; text?: string }[]; isError?: boolean };
      const body = (result.content ?? []).map((c) => (c.type === "text" ? c.text ?? "" : `[${c.type} omitted]`)).join("\n").trim();
      return result.isError ? `Error: ${body || "the tool reported a failure"}` : body || "(no output)";
    } catch (e) { return `Error: ${e instanceof Error ? e.message : String(e)}`; }
    finally { signal.removeEventListener("abort", abort); }
  }

  close(): void {
    this.#closed = true;
    this.#fail(new Error("the server was closed"));
    killTree(this.#child);
  }

  #detail(): string { const last = this.#stderr.trim().split("\n").slice(-2).join(" ").slice(0, 200); return last ? `: ${last}` : ""; }

  #request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (this.#closed) { reject(new Error("the server is not running")); return; }
      const id = this.#next++;
      const timer = setTimeout(() => this.#drop(id, new Error(`${method} took longer than ${Math.round(timeoutMs / 1000)} s`)), timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.#send({ jsonrpc: "2.0", id, method, params });
    });
  }

  #notify(method: string, params?: unknown): void { this.#send({ jsonrpc: "2.0", method, ...(params ? { params } : {}) }); }

  #send(message: unknown): void {
    try { this.#child.stdin?.write(`${JSON.stringify(message)}\n`); } catch { /* the process is gone; its end is handled */ }
  }

  #drop(id: number, error: Error): void {
    const p = this.#pending.get(id);
    if (!p) return;
    this.#pending.delete(id);
    clearTimeout(p.timer);
    p.reject(error);
  }

  #fail(error: Error): void { for (const id of [...this.#pending.keys()]) this.#drop(id, error); }

  #read(chunk: string): void {
    this.#buffer += chunk;
    for (let at = this.#buffer.indexOf("\n"); at >= 0; at = this.#buffer.indexOf("\n")) {
      const line = this.#buffer.slice(0, at).trim();
      this.#buffer = this.#buffer.slice(at + 1);
      if (!line) continue;
      let message: { id?: unknown; result?: unknown; error?: { message?: string } };
      try { message = JSON.parse(line); } catch { continue; }
      if (typeof message.id !== "number") continue;
      const p = this.#pending.get(message.id);
      if (!p) continue;
      this.#pending.delete(message.id);
      clearTimeout(p.timer);
      if (message.error) p.reject(new Error(message.error.message ?? "the server reported an error")); else p.resolve(message.result);
    }
    if (this.#buffer.length > 4_000_000) this.#buffer = "";
  }
}

/** The engine's view of one tool of a server. */
function toTool(client: McpLike, info: McpToolInfo, small: boolean): Tool {
  const server = client.name.replace(NAME, "_");
  const name = `mcp__${server}__${info.name.replace(NAME, "_")}`.slice(0, 64);
  const schema = info.inputSchema && typeof info.inputSchema === "object" ? info.inputSchema : {};
  return {
    name,
    readOnly: info.annotations?.readOnlyHint === true,
    description: `${(info.description ?? "").slice(0, 500)} (from the connected program "${client.name}")`.trim(),
    parameters: { type: "object", ...schema, properties: (schema.properties as Record<string, unknown> | undefined) ?? {} },
    offeredWhen: ({ small: tight, userText }) => !(small && tight) || userText.toLowerCase().includes(client.name.toLowerCase()) || userText.toLowerCase().includes(info.name.toLowerCase()),
    title: () => `${client.name}: ${info.name.replace(/[_-]+/g, " ")}`,
    async run(args, ctx) { return clip(await client.call(info.name, args, ctx.signal)); },
  };
}

export interface McpConnection {
  tools: Tool[];
  /** Servers that could not be used, with the reason in plain words. */
  problems: { server: string; reason: string }[];
  close(): void;
}

/** Starts every configured server at once. One that fails does not stop the others. */
export async function connectMcp(servers: Record<string, McpServerConfig>, small = false): Promise<McpConnection> {
  const clients: McpLike[] = [];
  const tools: Tool[] = [];
  const problems: { server: string; reason: string }[] = [];
  await Promise.all(Object.entries(servers).map(async ([name, config]) => {
    try {
      const client = config.url ? await McpHttpClient.start(name, config) : await McpClient.start(name, config);
      clients.push(client);
      const seen = new Set<string>();
      for (const info of await client.tools()) {
        const tool = toTool(client, info, small);
        if (!seen.has(tool.name)) { seen.add(tool.name); tools.push(tool); }
      }
    } catch (e) { problems.push({ server: name, reason: e instanceof Error ? e.message : String(e) }); }
  }));
  return { tools, problems, close: () => clients.forEach((c) => c.close()) };
}
