/**
 * A client for MCP servers: programs that give the agent more tools, and also resources (things to read) and prompts (ready-made requests).
 * A server is either started here as a child process and spoken to in JSON lines over its standard input and output, or reached over the web.
 * Its tools join the engine's own, named `mcp__<server>__<tool>` (see mcp-tools.ts).
 */
import { ChildEnv, spawn, type ChildProcess } from "./process-start.ts";
import { killTree, launch, usesProcessGroups } from "./platform.ts";
import { OAuthSession, type OAuthClient, type OAuthStore } from "./mcp-oauth.ts";
import { plain, type McpContent, type McpResult } from "./mcp-result.ts";
import { Deadline } from "./mcp-deadline.ts";
import { McpRequestError, type McpHandlers } from "./mcp-host.ts";

/** A server is either a program started here (`command`) or one reached over the web (`url`, with the headers it wants, such as a token). */
export interface McpServerConfig {
  command?: string;
  url?: string;
  headers?: Record<string, string>;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** For a server on the web that signs in by itself: what it needs when it cannot register navvied on its own. */
  oauth?: OAuthClient;
  /** What the server may ask of the model: `ask` (default: the person is asked each time, or once for the rest of the conversation), `allow` (never asked) or `off` (not offered to the server). */
  sampling?: "ask" | "allow" | "off";
  /** Whether the server may put questions to the person: `ask` (default) or `off`. */
  elicitation?: "ask" | "off";
  /** The most the model writes for one request of the server, in tokens (default 2000). */
  maxTokens?: number;
  /** The most requests for the model the server may make in one turn (default 3). */
  maxPerTurn?: number;
}

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean };
}
export interface McpResource { uri: string; name?: string; description?: string; mimeType?: string; /** `uri` is a template with `{name}` parts to fill. */ template?: true }
export interface McpPrompt { name: string; description?: string; arguments?: { name: string; description?: string; required?: boolean }[] }
export interface McpPromptText { description?: string; messages: { role: string; content: McpContent }[] }
export interface McpCapabilities { resources: boolean; prompts: boolean }

const PROTOCOL = "2025-06-18";
const HANDSHAKE_MS = 15_000;
const CALL_MS = 120_000;
const MOST_LISTED = 500;

const DOING: Record<string, string> = { initialize: "starting up", "tools/list": "listing its tools", "tools/call": "running a tool", "resources/list": "listing its resources", "resources/templates/list": "listing its resources", "resources/read": "reading a resource", "prompts/list": "listing its prompts", "prompts/get": "getting a prompt" };
const slow = (method: string, ms: number): string => `did not answer within ${Math.round(ms / 1000)} s while ${DOING[method] ?? method}`;

/** A server on the web wants a sign-in (or a better token than the one in its headers). */
export class McpAuthError extends Error {
  constructor(message: string, readonly signin: boolean, readonly challenge: string | null) { super(message); }
}

/** What the engine needs from a server, however it is reached. */
export interface McpLike {
  readonly name: string;
  readonly capabilities: McpCapabilities;
  tools(): Promise<McpToolInfo[]>;
  /** The raw answer of a tool. Throws when the server could not be asked. */
  callTool(tool: string, args: Record<string, unknown>, signal: AbortSignal): Promise<McpResult>;
  /** The text of the answer, a failure as an `Error:` line. */
  call(tool: string, args: Record<string, unknown>, signal: AbortSignal): Promise<string>;
  resources(): Promise<McpResource[]>;
  readResource(uri: string, signal: AbortSignal): Promise<McpContent[]>;
  prompts(): Promise<McpPrompt[]>;
  getPrompt(name: string, args: Record<string, string>, signal: AbortSignal): Promise<McpPromptText>;
  close(): void;
}

/** What every kind of server shares: the handshake, the lists that come in pages, and the calls. A kind says only how a message gets there. */
abstract class McpBase implements McpLike {
  capabilities: McpCapabilities = { resources: false, prompts: false };
  /** The version of the protocol the server answered with: it is sent back on every later request. */
  protected version = PROTOCOL;
  /** Ends when the server is closed: what is still being asked of this side then is stopped. */
  protected readonly life = new AbortController();
  readonly #live = new Set<Deadline>();
  #serving = 0;

  constructor(readonly name: string, private readonly handlers: McpHandlers = {}) {}

  /** The time limit of one request. It stands still while this side answers a request of the server (a question to the person takes as long as it takes). */
  protected limit(ms: number): Deadline {
    const d = new Deadline(ms);
    if (this.#serving) d.pause();
    this.#live.add(d);
    return d;
  }

  protected release(d: Deadline): void { d.end(); this.#live.delete(d); }

  /** The answer to a request the server made to this side. */
  protected async serve(method: string, params: unknown, signal: AbortSignal): Promise<{ result: unknown } | { error: { code: number; message: string } }> {
    if (method === "ping") return { result: {} };
    const handler = method === "sampling/createMessage" ? this.handlers.sampling : method === "elicitation/create" ? this.handlers.elicitation : undefined;
    if (!handler) return { error: { code: -32601, message: `${method} is not supported` } };
    this.#serving++;
    for (const d of this.#live) d.pause();
    try { return { result: await handler((params ?? {}) as Record<string, unknown>, signal) }; }
    catch (e) { return { error: e instanceof McpRequestError ? { code: e.code, message: e.message } : { code: -32603, message: e instanceof Error ? e.message : String(e) } }; }
    finally { if (--this.#serving === 0) for (const d of this.#live) d.resume(); }
  }

  protected abstract send(method: string, params: unknown, ms: number, signal?: AbortSignal): Promise<unknown>;
  protected abstract notify(method: string): Promise<void> | void;
  abstract close(): void;

  protected async handshake(): Promise<void> {
    const asked = { ...(this.handlers.sampling ? { sampling: {} } : {}), ...(this.handlers.elicitation ? { elicitation: {} } : {}) };
    const r = (await this.send("initialize", { protocolVersion: PROTOCOL, capabilities: asked, clientInfo: { name: "navvied", version: "1" } }, HANDSHAKE_MS)) as { protocolVersion?: unknown; capabilities?: { resources?: unknown; prompts?: unknown } } | undefined;
    if (typeof r?.protocolVersion === "string") this.version = r.protocolVersion;
    this.capabilities = { resources: !!r?.capabilities?.resources, prompts: !!r?.capabilities?.prompts };
    await this.notify("notifications/initialized");
  }

  async #list<T>(method: string, key: string): Promise<T[]> {
    const listed: T[] = [];
    let cursor: string | undefined;
    do {
      const page = (await this.send(method, cursor ? { cursor } : {}, HANDSHAKE_MS)) as Record<string, unknown> | undefined;
      listed.push(...((page?.[key] as T[] | undefined) ?? []));
      cursor = page?.nextCursor as string | undefined;
    } while (cursor && listed.length < MOST_LISTED);
    return listed;
  }

  tools(): Promise<McpToolInfo[]> { return this.#list("tools/list", "tools"); }

  async callTool(tool: string, args: Record<string, unknown>, signal: AbortSignal): Promise<McpResult> {
    return ((await this.send("tools/call", { name: tool, arguments: args }, CALL_MS, signal)) ?? {}) as McpResult;
  }

  async call(tool: string, args: Record<string, unknown>, signal: AbortSignal): Promise<string> {
    try { return plain(await this.callTool(tool, args, signal)); }
    catch (e) { return `Error: ${e instanceof Error ? e.message : String(e)}`; }
  }

  async resources(): Promise<McpResource[]> {
    const fixed = await this.#list<McpResource>("resources/list", "resources");
    // Templates are an extra: a server that has none may answer with an error, which is not a failure to list.
    const templates = await this.#list<{ uriTemplate: string; name?: string; description?: string; mimeType?: string }>("resources/templates/list", "resourceTemplates").catch(() => []);
    return [...fixed, ...templates.map((t) => ({ uri: t.uriTemplate, ...(t.name ? { name: t.name } : {}), ...(t.description ? { description: t.description } : {}), ...(t.mimeType ? { mimeType: t.mimeType } : {}), template: true as const }))];
  }

  async readResource(uri: string, signal: AbortSignal): Promise<McpContent[]> {
    const r = (await this.send("resources/read", { uri }, CALL_MS, signal)) as { contents?: { uri?: string; text?: string; blob?: string; mimeType?: string }[] } | undefined;
    return (r?.contents ?? []).map((c) => (c.mimeType?.startsWith("image/") && c.blob ? { type: "image", data: c.blob, mimeType: c.mimeType } : { type: "resource", resource: c }));
  }

  prompts(): Promise<McpPrompt[]> { return this.#list("prompts/list", "prompts"); }

  async getPrompt(name: string, args: Record<string, string>, signal: AbortSignal): Promise<McpPromptText> {
    const r = (await this.send("prompts/get", { name, arguments: args }, CALL_MS, signal)) as McpPromptText | undefined;
    return { ...(r?.description ? { description: r.description } : {}), messages: r?.messages ?? [] };
  }
}

const hasAuthorization = (headers: Record<string, string>): boolean => Object.keys(headers).some((k) => k.toLowerCase() === "authorization");

/**
 * A server reached over the web ("streamable HTTP"): every message is a POST, and the answer comes back either as JSON or as an event
 * stream that carries it. The server may give a session id on the first answer, which is sent back from then on. A server that asks for a
 * sign-in is answered with the token kept for it (see mcp-oauth.ts), renewed once when it is refused.
 */
export class McpHttpClient extends McpBase {
  #session: string | undefined;
  #next = 1;
  #closed = false;

  private constructor(name: string, private readonly url: string, private readonly headers: Record<string, string>, private readonly auth?: OAuthSession, handlers?: McpHandlers) { super(name, handlers); }

  static async start(name: string, config: McpServerConfig, store?: OAuthStore, handlers?: McpHandlers): Promise<McpHttpClient> {
    if (!config.url || !/^https?:\/\//.test(config.url)) throw new Error("the address must start with http:// or https://");
    const headers = config.headers ?? {};
    const client = new McpHttpClient(name, config.url, headers, store && !hasAuthorization(headers) ? new OAuthSession(config.url, store) : undefined, handlers);
    try { await client.handshake(); return client; } catch (e) { client.close(); throw e; }
  }

  protected send(method: string, params: unknown, ms: number, signal?: AbortSignal): Promise<unknown> {
    if (this.#closed) return Promise.reject(new Error("the server is not connected"));
    const id = this.#next++;
    return this.#post({ jsonrpc: "2.0", id, method, params }, id, ms, signal);
  }

  protected async notify(method: string): Promise<void> { await this.#post({ jsonrpc: "2.0", method }, undefined, HANDSHAKE_MS); }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.life.abort();
    if (this.#session) void fetch(this.url, { method: "DELETE", headers: { ...this.headers, "mcp-session-id": this.#session }, signal: AbortSignal.timeout(3000) }).catch(() => undefined);
  }

  async #post(message: Record<string, unknown>, id: number | undefined, ms: number, outer?: AbortSignal, renewed = false): Promise<unknown> {
    const limit = this.limit(ms);
    try { return await this.#exchange(message, id, ms, limit.signal, outer, renewed); } finally { this.release(limit); }
  }

  async #exchange(message: Record<string, unknown>, id: number | undefined, ms: number, time: AbortSignal, outer: AbortSignal | undefined, renewed: boolean): Promise<unknown> {
    const stop = AbortSignal.any([time, ...(outer ? [outer] : [])]);
    const bearer = await this.auth?.header();
    let res: Response;
    try {
      res = await fetch(this.url, { method: "POST", signal: stop, body: JSON.stringify(message), headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": this.version, ...(this.#session ? { "mcp-session-id": this.#session } : {}), ...(bearer ? { authorization: bearer } : {}), ...this.headers } });
    } catch (e) { throw new Error(outer?.aborted ? "[interrupted]" : stop.aborted ? slow(String(message.method), ms) : `could not be reached: ${e instanceof Error ? e.message : String(e)}`); }
    const session = res.headers.get("mcp-session-id");
    if (session) this.#session = session;
    if (res.status === 401 && !hasAuthorization(this.headers)) {
      await res.body?.cancel().catch(() => undefined);
      if (this.auth && !renewed && await this.auth.renew()) return this.#post(message, id, ms, outer, true);
      throw new McpAuthError("needs a sign-in", true, res.headers.get("www-authenticate"));
    }
    if (id === undefined) { await res.body?.cancel().catch(() => undefined); return undefined; }
    if (!res.ok) throw new McpAuthError(res.status === 401 || res.status === 403 ? `the server did not accept the token in its headers (${res.status})` : res.status === 404 ? "the server answered 404: check the address" : res.status >= 500 ? `the server answered ${res.status}: it has a problem of its own` : `the server answered ${res.status}`, false, null);
    const reply = (res.headers.get("content-type") ?? "").includes("text/event-stream") ? await this.#fromStream(res, id, stop, outer) : await this.#json(res);
    const found = (Array.isArray(reply) ? reply : [reply]).find((m) => (m as { id?: unknown }).id === id) as { result?: unknown; error?: { message?: string } } | undefined;
    if (!found) throw new Error("the server did not answer that request");
    if (found.error) throw new Error(found.error.message ?? "the server reported an error");
    return found.result;
  }

  async #json(res: Response): Promise<unknown> {
    const body = await res.text();
    try { return JSON.parse(body) as unknown; }
    catch { throw new Error(`the server's answer was not JSON${/^\s*</.test(body) ? " (it is a web page: is the address right?)" : ""}`); }
  }

  /** What the server asked of this side on a stream is answered with a request of its own to the server. */
  async #answer(m: { id: unknown; method: string; params?: unknown }, outer?: AbortSignal): Promise<void> {
    const out = await this.serve(m.method, m.params, outer ? AbortSignal.any([this.life.signal, outer]) : this.life.signal);
    await this.#post({ jsonrpc: "2.0", id: m.id, ...out }, undefined, HANDSHAKE_MS).catch(() => undefined);
  }

  /** Reads an event stream until the answer to `id` has come; requests of the server on the way are answered. */
  async #fromStream(res: Response, id: number, stop: AbortSignal, outer?: AbortSignal): Promise<unknown> {
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
          let m: { id?: unknown; method?: unknown; params?: unknown };
          try { m = JSON.parse(data) as typeof m; } catch { continue; }
          if (typeof m.method === "string") { if (m.id !== undefined) void this.#answer({ id: m.id, method: m.method, params: m.params }, outer); continue; }
          if (m.id === id) return m;
        }
        if (stop.aborted) break;
      }
    } finally { void reader.cancel().catch(() => undefined); }
    throw new Error("the stream ended without an answer");
  }
}

type Pending = { resolve(value: unknown): void; reject(error: Error): void; limit: Deadline };

export class McpClient extends McpBase {
  #child: ChildProcess;
  #next = 1;
  #pending = new Map<number, Pending>();
  #buffer = "";
  #stderr = "";
  #noise = "";
  #closed = false;

  private constructor(name: string, child: ChildProcess, command: string, handlers?: McpHandlers) {
    super(name, handlers);
    this.#child = child;
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.#read(chunk));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => { this.#stderr = (this.#stderr + chunk).slice(-2000); });
    child.stdin?.on("error", () => undefined);
    child.on("error", (e: NodeJS.ErrnoException) => this.#fail(new Error(`could not start: ${e.code === "ENOENT" ? `"${command}" was not found on this computer` : e.code === "EACCES" ? `"${command}" is not allowed to run` : e.message}`)));
    child.on("close", (code) => { if (!this.#closed) this.#fail(new Error(`stopped by itself (exit ${code})${this.#detail()}`)); });
  }

  /** Starts the server and completes the handshake, or throws with the reason. */
  static async start(name: string, config: McpServerConfig, started?: (client: McpClient) => void, handlers?: McpHandlers): Promise<McpClient> {
    if (!config.command) throw new Error("a connected program needs a command or an address");
    const [program, ...args] = launch([config.command, ...(config.args ?? [])]);
    const child = spawn(program!, args, { cwd: config.cwd, env: ChildEnv.forServer().with(config.env), detached: usesProcessGroups(), windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const client = new McpClient(name, child, config.command, handlers);
    started?.(client);
    try { await client.handshake(); return client; } catch (e) { client.close(); throw e; }
  }

  /** A call that is stopped tells the server, and leaves it usable. */
  override async callTool(tool: string, args: Record<string, unknown>, signal: AbortSignal): Promise<McpResult> {
    const id = this.#next;
    const abort = (): void => { this.#notify("notifications/cancelled", { requestId: id, reason: "the user stopped the turn" }); this.#drop(id, new Error("[interrupted]")); };
    signal.addEventListener("abort", abort, { once: true });
    try { return await super.callTool(tool, args, signal); } finally { signal.removeEventListener("abort", abort); }
  }

  close(): void {
    this.#closed = true;
    this.life.abort();
    this.#fail(new Error("the server was closed"));
    killTree(this.#child);
  }

  /** The last words the program wrote to its error output, or the text it printed where only JSON belongs. */
  #detail(): string {
    const last = this.#stderr.trim().split("\n").slice(-2).join(" ").slice(0, 200);
    return last ? `: ${last}` : this.#noise ? `; it printed "${this.#noise}", which is not JSON: a tool server may print only JSON messages on its output` : "";
  }

  protected send(method: string, params: unknown, ms: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (this.#closed) { reject(new Error("the server is not running")); return; }
      const id = this.#next++;
      const limit = this.limit(ms);
      limit.signal.addEventListener("abort", () => this.#drop(id, new Error(`${slow(method, ms)}${this.#detail()}`)), { once: true });
      this.#pending.set(id, { resolve, reject, limit });
      this.#write({ jsonrpc: "2.0", id, method, params });
    });
  }

  protected notify(method: string): void { this.#notify(method); }

  #notify(method: string, params?: unknown): void { this.#write({ jsonrpc: "2.0", method, ...(params ? { params } : {}) }); }

  #write(message: unknown): void {
    try { this.#child.stdin?.write(`${JSON.stringify(message)}\n`); } catch { /* the process is gone; its end is handled */ }
  }

  #drop(id: number, error: Error): void {
    const p = this.#pending.get(id);
    if (!p) return;
    this.#pending.delete(id);
    this.release(p.limit);
    p.reject(error);
  }

  /** What the server asked of this side is answered on the same line. */
  async #answer(m: { id: unknown; method: string; params?: unknown }): Promise<void> {
    this.#write({ jsonrpc: "2.0", id: m.id, ...(await this.serve(m.method, m.params, this.life.signal)) });
  }

  #fail(error: Error): void { for (const id of [...this.#pending.keys()]) this.#drop(id, error); }

  #read(chunk: string): void {
    this.#buffer += chunk;
    for (let at = this.#buffer.indexOf("\n"); at >= 0; at = this.#buffer.indexOf("\n")) {
      const line = this.#buffer.slice(0, at).trim();
      this.#buffer = this.#buffer.slice(at + 1);
      if (!line) continue;
      let message: { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: { message?: string } };
      try { message = JSON.parse(line); } catch { this.#noise ||= line.slice(0, 60); continue; }
      if (typeof message.method === "string") { if (message.id !== undefined) void this.#answer({ id: message.id, method: message.method, params: message.params }); continue; }
      if (typeof message.id !== "number") continue;
      const p = this.#pending.get(message.id);
      if (!p) continue;
      this.#pending.delete(message.id);
      this.release(p.limit);
      if (message.error) p.reject(new Error(message.error.message ?? "the server reported an error")); else p.resolve(message.result);
    }
    if (this.#buffer.length > 4_000_000) this.#buffer = "";
  }
}
