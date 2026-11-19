/**
 * `navvied acp`: the Agent Client Protocol, so an editor that speaks it (Zed and others) can use navvied as its agent. It is JSON-RPC 2.0,
 * one message per line on standard input and output. Every session is an engine of its own; what the engine says is passed to the
 * editor as updates, and the engine's questions ("may I change this file?") become the editor's permission prompts.
 */
import { LineSplitter, type EngineEvent, type PermMode } from "@navvied/protocol";
import type { Options } from "../args.ts";
import { createEngine, type Created } from "../create.ts";
import type { IO } from "../io.ts";
import { VERSION } from "../help.ts";
import { EXIT } from "./run.ts";

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

const KIND: Record<string, string> = { Read: "read", Write: "edit", Edit: "edit", Bash: "execute", Glob: "search", Grep: "search", WebFetch: "fetch", WebSearch: "fetch" };
const PLAN_STATUS: Record<string, string> = { pending: "pending", in_progress: "in_progress", completed: "completed" };

interface Session { id: string; created: Created; cwd: string; running?: { resolve(stop: string): void }; announced: Set<string>; mode: PermMode }

export async function acpCommand(options: Options, io: IO): Promise<number> {
  const sessions = new Map<string, Session>();
  const waiting = new Map<number | string, (result: unknown) => void>();
  let nextId = 1;

  const write = (message: Json): void => { io.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`); };
  const reply = (id: unknown, result: unknown): void => write({ id, result });
  const fail = (id: unknown, code: number, message: string): void => write({ id, error: { code, message } });
  const notify = (sessionId: string, update: Json): void => write({ method: "session/update", params: { sessionId, update } });
  const ask = (method: string, params: Json): Promise<unknown> => new Promise((resolve) => { const id = nextId++; waiting.set(id, resolve); write({ id, method, params }); });

  /** What an engine event looks like to the editor. */
  const forward = (s: Session, e: EngineEvent): void => {
    if (e.ev === "text") notify(s.id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: e.text } });
    else if (e.ev === "thought") notify(s.id, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: e.text } });
    else if (e.ev === "tool") {
      const id = e.id;
      if (!s.announced.has(id)) {
        s.announced.add(id);
        notify(s.id, { sessionUpdate: "tool_call", toolCallId: id, title: e.name, kind: KIND[e.name] ?? "other", status: e.status === "running" ? "in_progress" : "pending", ...(e.input !== undefined ? { rawInput: e.input } : {}) });
      } else if (e.status === "running") {
        if (e.input !== undefined) notify(s.id, { sessionUpdate: "tool_call_update", toolCallId: id, status: "in_progress", rawInput: e.input });
      }
      if (e.status === "done" || e.status === "error") {
        notify(s.id, { sessionUpdate: "tool_call_update", toolCallId: id, status: e.status === "done" ? "completed" : "failed", ...(e.output ? { content: [{ type: "content", content: { type: "text", text: e.output.slice(0, 4000) } }] } : {}) });
      }
    } else if (e.ev === "plan") notify(s.id, { sessionUpdate: "plan", entries: e.entries.map((p) => ({ content: p.title, priority: "medium", status: PLAN_STATUS[p.status] ?? "pending" })) });
    else if (e.ev === "error") notify(s.id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `Error: ${e.msg}` } });
    else if (e.ev === "notice") notify(s.id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `${e.msg}\n` } });
    else if (e.ev === "approval") void permission(s, e);
    else if (e.ev === "done") { const r = s.running; s.running = undefined; s.announced.clear(); r?.resolve(e.stop === "cancelled" ? "cancelled" : "end_turn"); }
  };

  const permission = async (s: Session, e: Extract<EngineEvent, { ev: "approval" }>): Promise<void> => {
    const answer = await ask("session/request_permission", {
      sessionId: s.id,
      toolCall: { toolCallId: e.id, title: e.title },
      options: e.options.filter((o) => !o.editable).map((o) => ({ optionId: o.optionId, name: o.name, kind: o.kind })),
    });
    const outcome = isObject(answer) && isObject(answer.outcome) ? answer.outcome : undefined;
    const picked = outcome?.outcome === "selected" && typeof outcome.optionId === "string" ? outcome.optionId : "deny";
    s.created.engine.handle({ cmd: "approve", id: e.id, optionId: picked });
  };

  const create = (cwd: string): Session | string => {
    const id = crypto.randomUUID();
    const holder: { session?: Session } = {};
    const made = createEngine({ ...options, cwd }, io, (e) => { if (holder.session) forward(holder.session, e); });
    if (!made.ok) return made.error;
    const session: Session = { id, created: made.value, cwd, announced: new Set(), mode: options.mode ?? "ask" };
    holder.session = session;
    sessions.set(id, session);
    return session;
  };

  const handle = async (m: Json): Promise<void> => {
    const { id, method } = m as { id?: number | string; method?: string };
    const params = isObject(m.params) ? m.params : {};
    if (method === undefined) { if (id !== undefined) { waiting.get(id)?.(m.result ?? m.error); waiting.delete(id); } return; }
    if (method === "initialize") {
      reply(id, { protocolVersion: 1, agentCapabilities: { loadSession: false, promptCapabilities: { image: false, audio: false, embeddedContext: true } }, authMethods: [], agentInfo: { name: "navvied", version: VERSION } });
    } else if (method === "session/new") {
      const cwd = typeof params.cwd === "string" && params.cwd ? params.cwd : options.cwd ?? process.cwd();
      const s = create(cwd);
      if (typeof s === "string") fail(id, -32000, s); else reply(id, { sessionId: s.id });
    } else if (method === "session/prompt") {
      const s = typeof params.sessionId === "string" ? sessions.get(params.sessionId) : undefined;
      if (!s) { fail(id, -32602, "unknown session"); return; }
      if (s.running) { fail(id, -32000, "this session is already working on a message"); return; }
      const parts = Array.isArray(params.prompt) ? params.prompt : [];
      const text = parts.map((p) => (isObject(p) && p.type === "text" && typeof p.text === "string" ? p.text : isObject(p) && p.type === "resource" && isObject(p.resource) && typeof p.resource.text === "string" ? `\n[${String(p.resource.uri ?? "file")}]\n${p.resource.text}` : "")).join("\n").trim();
      if (!text) { fail(id, -32602, "the message has no text"); return; }
      const stop = await new Promise<string>((resolve) => { s.running = { resolve }; s.created.engine.handle({ cmd: "prompt", text, qid: crypto.randomUUID(), mode: s.mode }); });
      reply(id, { stopReason: stop });
    } else if (method === "session/cancel") {
      const s = typeof params.sessionId === "string" ? sessions.get(params.sessionId) : undefined;
      s?.created.engine.handle({ cmd: "cancel" });
    } else if (id !== undefined) fail(id, -32601, `method not supported: ${method}`);
  };

  const lines = new LineSplitter();
  const run = (line: string): void => {
    let message: unknown;
    try { message = JSON.parse(line); } catch { write({ id: null, error: { code: -32700, message: "not JSON" } }); return; }
    if (isObject(message)) void handle(message).catch((e: unknown) => { if (message.id !== undefined) fail(message.id, -32603, e instanceof Error ? e.message : "internal error"); });
  };
  for await (const chunk of io.stdin) { try { for (const line of lines.push(chunk)) run(line); } catch { write({ id: null, error: { code: -32700, message: "message too long" } }); } }
  for (const line of lines.flush()) run(line);
  for (const s of sessions.values()) { await s.created.engine.idle().catch(() => undefined); s.created.engine.close(); }
  return EXIT.ok;
}
