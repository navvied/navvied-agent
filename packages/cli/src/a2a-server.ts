/**
 * Being asked by other agents (`navvied serve --a2a`): the Agent Card, and JSON-RPC calls (`message/send`, `message/stream`, `tasks/get`,
 * `tasks/cancel`) from agents that hold a token made on this computer. Off unless started. A peer has no authority here:
 *  - it is who its token says, never what a request says;
 *  - what it writes is framed as another agent's words before any model reads it;
 *  - it cannot choose a permission mode; the conversation runs in the mode the person set for peers (plan unless changed);
 *  - everything is bounded: request size, rate, tasks at once, conversations kept, turns per conversation, time per task, answer size.
 * Each peer has conversations of its own (a context is its own: another peer cannot name it), run by a `TaskRunner`.
 */
import { A2A_ERR as ERR, CARD_PATH, CARD_PATH_LEGACY, FINAL_STATES, a2aNow, agentCard, newId, redact, rpcError, rpcResult, textMessage, textOf, untrusted, type Skill, type TaskState } from "@navvied/engine";
import type { A2aLimits } from "./a2a-config.ts";
import type { PeerTokens } from "./a2a-tokens.ts";

export interface RunJob { peer: string; context: string; /** Already framed as another agent's words. */ text: string; signal: AbortSignal; /** Words of the answer as they are written. */ progress(text: string): void }
export interface RunResult { state: "completed" | "failed"; text: string }
export interface TaskRunner {
  run(job: RunJob): Promise<RunResult>;
  /** The conversation is closed and forgotten. */
  drop(peer: string, context: string): void;
  close(): void;
}

export interface A2aServerOptions {
  tokens: PeerTokens;
  runner: TaskRunner;
  limits: A2aLimits;
  card: { name: string; description: string; version: string; skills: Skill[] };
  host: string;
  port: number;
  /** What the card says this server is reached at (default: the address it listens on). */
  url?: string;
  now?: () => number;
  /** One line per exchange for the person's record (no secret is in it). */
  audit?: (line: { at: string; peer: string; task: string; what: "asked" | "answered" | "refused"; text: string }) => void;
}

export interface A2aServer {
  port: number;
  url: string;
  /** One request exactly as a direct one: the relay's forwarder calls this with what it received and the address it came from (for the limit on wrong tokens). */
  handle(req: Request, address?: string): Promise<Response>;
  stop(): Promise<void>;
}

interface Context { peer: string; id: string; turns: number; busy: boolean; last: number }
interface Rec {
  id: string; peer: string; context: string; state: TaskState; answer: string; created: number; finished?: number;
  abort: AbortController; done: Promise<void>; listen: Set<(event: object) => void>;
  /** What was said so far, for a stream that is opened after the words began (bounded like an answer). */
  said: string[]; saidChars: number;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const CONTEXT_ID = /^[\w.:-]{1,128}$/;
const KEEP_MS = 60 * 60_000;
const KEEP_TASKS = 100;
const PATHS = new Set(["/", "/a2a"]);

export function startA2aServer(o: A2aServerOptions): A2aServer {
  const now = o.now ?? Date.now;
  const L = o.limits;
  const tasks = new Map<string, Rec>();
  const contexts = new Map<string, Context>();
  const keyOf = (peer: string, id: string): string => `${peer}\0${id}`;
  const hits = new Map<string, number[]>();
  const loopbackOnly = LOOPBACK.has(o.host);
  const wrong = new Map<string, number[]>();
  /** Wrong tokens from one address: after the limit in an hour, even a right one is turned away until the hour has passed. */
  const locked = (address: string): boolean => { const t = now(); const recent = (wrong.get(address) ?? []).filter((x) => t - x < 3_600_000); wrong.set(address, recent); return recent.length >= L.wrongPerHour; };

  const json = (body: unknown, status = 200, extra: Record<string, string> = {}): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff", ...extra } });
  const failure = (id: unknown, code: number, message: string): Response => json(rpcError(id, code, message));

  const running = (peer?: string): number => [...tasks.values()].filter((t) => !FINAL_STATES.has(t.state) && (peer === undefined || t.peer === peer)).length;
  const prune = (): void => {
    const t = now();
    for (const [id, rec] of tasks) if (rec.finished !== undefined && t - rec.finished > KEEP_MS) tasks.delete(id);
    const finished = [...tasks.values()].filter((r) => r.finished !== undefined).sort((a, b) => a.finished! - b.finished!);
    for (const rec of finished.slice(0, Math.max(0, finished.length - KEEP_TASKS))) tasks.delete(rec.id);
  };
  const allowed = (peer: string): boolean => {
    const t = now();
    const recent = (hits.get(peer) ?? []).filter((x) => t - x < 60_000);
    if (recent.length >= L.perMinute) { hits.set(peer, recent); return false; }
    recent.push(t);
    hits.set(peer, recent);
    return true;
  };

  const words = (rec: Rec, t: string): object => ({ kind: "status-update", taskId: rec.id, contextId: rec.context, status: { state: "working", timestamp: a2aNow(now()), message: textMessage("agent", redact(t), rec.context, rec.id) }, final: false });
  const view = (rec: Rec, withAnswer = true): object => ({
    kind: "task", id: rec.id, contextId: rec.context,
    status: { state: rec.state, timestamp: a2aNow(rec.finished ?? rec.created) },
    ...(withAnswer && rec.finished !== undefined && rec.answer ? { artifacts: [{ artifactId: `${rec.id}-answer`, name: "answer", parts: [{ kind: "text", text: rec.answer }] }] } : {}),
  });
  const end = (rec: Rec, state: TaskState, answer: string): void => {
    if (rec.finished !== undefined) return;
    rec.state = state;
    rec.answer = answer;
    rec.finished = now();
    const ctx = contexts.get(keyOf(rec.peer, rec.context));
    if (ctx) { ctx.busy = false; ctx.last = now(); }
    const status = { state, timestamp: a2aNow(rec.finished) };
    if (answer) for (const f of rec.listen) f({ kind: "artifact-update", taskId: rec.id, contextId: rec.context, artifact: { artifactId: `${rec.id}-answer`, name: "answer", parts: [{ kind: "text", text: answer }] }, lastChunk: true });
    for (const f of rec.listen) f({ kind: "status-update", taskId: rec.id, contextId: rec.context, status, final: true });
    o.audit?.({ at: a2aNow(now()), peer: rec.peer, task: rec.id, what: "answered", text: answer.slice(0, 200) });
  };

  /** A conversation for this peer to talk in: the one it named, or a new one, making room by letting the oldest idle one go. */
  const room = (peer: string, named: string | undefined): Context | number => {
    const had = named ? contexts.get(keyOf(peer, named)) : undefined;
    if (had) return had;
    const idle = (list: Context[]): Context | undefined => list.filter((c) => !c.busy).sort((a, b) => a.last - b.last)[0];
    const make = (from: Context[], most: number): boolean => {
      if (from.length < most) return true;
      const old = idle(from);
      if (!old) return false;
      contexts.delete(keyOf(old.peer, old.id));
      o.runner.drop(old.peer, old.id);
      return true;
    };
    const mine = [...contexts.values()].filter((c) => c.peer === peer);
    if (!make(mine, L.contextsPerPeer) || !make([...contexts.values()], L.contextsTotal)) return ERR.busy;
    const ctx: Context = { peer, id: named ?? newId("ctx"), turns: 0, busy: false, last: now() };
    contexts.set(keyOf(peer, ctx.id), ctx);
    return ctx;
  };

  /** Starts a task for the message in `params`, or says why not as `[code, words]`. */
  const start = (peer: string, params: unknown): Rec | [number, string] => {
    const message = (params as { message?: unknown } | null)?.message as { role?: unknown; parts?: unknown; contextId?: unknown; taskId?: unknown } | undefined;
    if (!message || typeof message !== "object" || !Array.isArray(message.parts)) return [ERR.params, "send a message with parts: {\"message\": {\"role\": \"user\", \"parts\": [{\"kind\": \"text\", \"text\": \"...\"}]}}"];
    if (message.role !== undefined && message.role !== "user" && message.role !== "ROLE_USER") return [ERR.params, "the role of the message must be user"];
    const text = textOf({ parts: message.parts }).trim();
    if (!text) return [ERR.params, "the message has no text"];
    if (text.length > L.messageChars) return [ERR.tooLarge, `the message is longer than ${L.messageChars} characters`];
    if (message.contextId !== undefined && !(typeof message.contextId === "string" && CONTEXT_ID.test(message.contextId))) return [ERR.params, "contextId must be letters, digits, dots, dashes, colons or underscores (at most 128)"];
    if (message.taskId !== undefined) {
      const earlier = typeof message.taskId === "string" ? tasks.get(message.taskId) : undefined;
      if (!earlier || earlier.peer !== peer) return [ERR.taskNotFound, "there is no such task"];
      return [ERR.params, "this task is finished: send a new message with the same contextId to go on"];
    }
    prune();
    if (running(peer) >= L.tasksPerPeer || running() >= L.tasksTotal) return [ERR.busy, "too many tasks are running; wait for one to finish"];
    const ctx = room(peer, message.contextId as string | undefined);
    if (typeof ctx === "number") return [ctx, "all conversations are busy; wait for one to finish"];
    if (ctx.busy) return [ERR.busy, "this conversation is still working on a task"];
    if (ctx.turns >= L.turns) return [ERR.turns, `this conversation has reached ${L.turns} messages; start a new one without a contextId`];
    ctx.turns += 1;
    ctx.busy = true;
    const abort = new AbortController();
    const rec: Rec = { id: newId("task"), peer, context: ctx.id, state: "working", answer: "", created: now(), abort, done: Promise.resolve(), listen: new Set(), said: [], saidChars: 0 };
    tasks.set(rec.id, rec);
    o.audit?.({ at: a2aNow(now()), peer, task: rec.id, what: "asked", text: redact(text).slice(0, 200) });
    const timer = setTimeout(() => { abort.abort(); end(rec, "failed", `The task took longer than ${L.taskSeconds} seconds and was stopped.`); }, L.taskSeconds * 1000);
    timer.unref?.();
    rec.done = o.runner.run({ peer, context: ctx.id, text: untrusted("agent", text, peer), signal: abort.signal, progress: (t) => { if (t && rec.finished === undefined && rec.saidChars < L.answerChars) { rec.said.push(t); rec.saidChars += t.length; for (const f of rec.listen) f(words(rec, t)); } } })
      .then((r) => end(rec, r.state, redact(r.text).slice(0, L.answerChars) || (r.state === "failed" ? "The task failed." : "")), () => end(rec, "failed", "The task failed."))
      .finally(() => clearTimeout(timer));
    return rec;
  };

  const stream = (id: unknown, rec: Rec): Response => {
    const enc = new TextEncoder();
    let off = (): void => undefined;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        const send = (event: object): void => { try { c.enqueue(enc.encode(`data: ${JSON.stringify(rpcResult(id, event))}\n\n`)); } catch { /* the reader has gone */ } };
        const listener = (event: object): void => { send(event); if ((event as { final?: boolean }).final) { rec.listen.delete(listener); try { c.close(); } catch { /* closed */ } } };
        send(view(rec, false));
        if (rec.finished !== undefined) { if (rec.answer) send({ kind: "artifact-update", taskId: rec.id, contextId: rec.context, artifact: { artifactId: `${rec.id}-answer`, name: "answer", parts: [{ kind: "text", text: rec.answer }] }, lastChunk: true }); send({ kind: "status-update", taskId: rec.id, contextId: rec.context, status: { state: rec.state, timestamp: a2aNow(rec.finished) }, final: true }); c.close(); return; }
        for (const t of rec.said) send(words(rec, t));
        rec.listen.add(listener);
        off = () => rec.listen.delete(listener);
      },
      cancel() { off(); },
    });
    return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
  };

  const call = async (peer: string, req: { id?: unknown; method?: unknown; params?: unknown }): Promise<Response> => {
    const id = req.id ?? null;
    const params = (req.params ?? {}) as Record<string, unknown>;
    switch (req.method) {
      case "message/send": case "SendMessage": case "message/stream": case "SendStreamingMessage": {
        const rec = start(peer, params);
        if (Array.isArray(rec)) { o.audit?.({ at: a2aNow(now()), peer, task: "", what: "refused", text: rec[1] }); return failure(id, rec[0], rec[1]); }
        if (req.method === "message/stream" || req.method === "SendStreamingMessage") return stream(id, rec);
        const blocking = (params.configuration as { blocking?: unknown } | undefined)?.blocking === true;
        if (blocking) await rec.done;
        return json(rpcResult(id, view(rec)));
      }
      case "tasks/get": case "GetTask": {
        const rec = typeof params.id === "string" ? tasks.get(params.id) : undefined;
        return !rec || rec.peer !== peer ? failure(id, ERR.taskNotFound, "there is no such task") : json(rpcResult(id, view(rec)));
      }
      case "tasks/cancel": case "CancelTask": {
        const rec = typeof params.id === "string" ? tasks.get(params.id) : undefined;
        if (!rec || rec.peer !== peer) return failure(id, ERR.taskNotFound, "there is no such task");
        if (rec.finished !== undefined) return failure(id, ERR.notCancelable, "the task is already finished");
        rec.abort.abort();
        end(rec, "canceled", "");
        return json(rpcResult(id, view(rec)));
      }
      case "tasks/resubscribe": case "tasks/list": return failure(id, ERR.unsupported, "this agent does not support that call; use tasks/get");
      default:
        return typeof req.method === "string" && req.method.startsWith("tasks/pushNotificationConfig") ? failure(id, ERR.pushUnsupported, "this agent does not send push notifications") : failure(id, ERR.method, "unknown method");
    }
  };

  const handle = async (req: Request, address = "local"): Promise<Response> => {
    {
      const url = new URL(req.url);
      // A page in a browser can reach a loopback address by a name it controls: only the names of this computer are served there.
      if (loopbackOnly && !LOOPBACK.has(url.hostname)) return new Response("forbidden\n", { status: 403 });
      if (req.method === "GET" && (url.pathname === CARD_PATH || url.pathname === CARD_PATH_LEGACY)) return json(agentCard({ ...o.card, url: `${o.url ?? shown}/` }));
      if (req.method !== "POST" || !PATHS.has(url.pathname)) return new Response("not found\n", { status: 404 });
      // Only a browser sends these, and a page must never be able to make this computer's agent work.
      if (req.headers.get("origin") !== null || (req.headers.get("sec-fetch-site") ?? "none") === "cross-site") return new Response("forbidden\n", { status: 403 });
      const bearer = /^Bearer (.+)$/i.exec(req.headers.get("authorization") ?? "")?.[1]?.trim();
      if (locked(address)) return new Response("too many wrong tokens\n", { status: 429, headers: { "retry-after": "3600" } });
      const peer = bearer ? o.tokens.who(bearer) : undefined;
      if (!peer) { wrong.set(address, [...(wrong.get(address) ?? []), now()]); return new Response("unauthorised\n", { status: 401, headers: { "www-authenticate": "Bearer" } }); }
      if (!/^application\/json\b/i.test(req.headers.get("content-type") ?? "")) return new Response("send application/json\n", { status: 415 });
      if (!allowed(peer)) return json(rpcError(null, ERR.rate, `more than ${L.perMinute} requests in a minute`), 429, { "retry-after": "60" });
      if (Number(req.headers.get("content-length") ?? 0) > L.bodyBytes) return json(rpcError(null, ERR.tooLarge, "the request is too large"), 413);
      let text: string;
      try { text = await req.text(); } catch { return json(rpcError(null, ERR.tooLarge, "the request is too large"), 413); }
      if (text.length > L.bodyBytes) return json(rpcError(null, ERR.tooLarge, "the request is too large"), 413);
      let body: { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
      try { body = JSON.parse(text) as typeof body; } catch { return json(rpcError(null, ERR.parse, "the request is not JSON")); }
      if (typeof body !== "object" || body === null || Array.isArray(body) || body.jsonrpc !== "2.0" || typeof body.method !== "string") return json(rpcError(null, ERR.request, "send a JSON-RPC 2.0 request"));
      return call(peer, body);
    }
  };
  const server = Bun.serve({ port: o.port, hostname: o.host, maxRequestBodySize: L.bodyBytes, fetch: (req, srv) => handle(req, srv.requestIP(req)?.address ?? "local") });
  const listening = server.hostname === "::" || server.hostname === "0.0.0.0" ? "127.0.0.1" : server.hostname;
  const shown = `http://${listening?.includes(":") ? `[${listening}]` : listening}:${server.port}`;
  return {
    port: server.port ?? 0,
    url: o.url ?? shown,
    handle,
    async stop() {
      for (const rec of tasks.values()) if (rec.finished === undefined) { rec.abort.abort(); end(rec, "canceled", ""); }
      await server.stop(true);
      o.runner.close();
    },
  };
}
