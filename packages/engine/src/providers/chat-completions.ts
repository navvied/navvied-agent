/**
 * Provider for the common chat-completions HTTP API — the one hosted services, gateways and local model servers
 * (llama.cpp, Ollama, vLLM, LM Studio, …) all speak. Streaming, tool calls, reasoning text and token usage are supported.
 */
import type { Message, ModelReply, ModelRequest, Part, Provider, StreamHandlers, ToolCall } from "../types.ts";
import { sseData } from "./sse.ts";
import { fetchModel, retryAfterMs } from "./net.ts";


export interface ChatCompletionsConfig {
  /** Base URL including the version prefix, e.g. `http://127.0.0.1:11434/v1`. */
  baseUrl: string;
  model: string;
  apiKey?: string;
  /** `effort`: send the effort as `reasoning_effort`. `none`: never send it (models that reject the field). */
  reasoning?: "effort" | "none";
  /** Where the effort goes: `reasoning_effort` (the usual) or a `reasoning` object with `effort` in it (a few services take that one). */
  effortField?: "reasoning_effort" | "reasoning";
  headers?: Record<string, string>;
}

export class ProviderError extends Error {
  constructor(message: string, readonly status?: number, /** How long the service asked to wait before another try, in milliseconds. */ readonly retryAfterMs?: number) { super(message); this.name = "ProviderError"; }
}

const part = (p: Part) => (p.type === "text" ? { type: "text", text: p.text } : { type: "image_url", image_url: { url: `data:${p.mime};base64,${p.data}` } });
/** A file part is a PDF for a service that reads them; this API has no place for one, and its text is already in the message. */
const sendable = (p: Part): boolean => p.type !== "file";

export function toWire(m: Message): Record<string, unknown> {
  if (m.role === "tool") return { role: "tool", tool_call_id: m.toolCallId, content: typeof m.content === "string" ? m.content : "" };
  const content = m.content === undefined ? null : typeof m.content === "string" ? m.content : m.content.filter(sendable).map(part);
  const out: Record<string, unknown> = { role: m.role, content };
  if (m.toolCalls?.length) out.tool_calls = m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } }));
  return out;
}

export class ChatCompletionsProvider implements Provider {
  constructor(private readonly cfg: ChatCompletionsConfig) {}

  private url(): string { return `${this.cfg.baseUrl.replace(/\/+$/, "")}/chat/completions`; }
  private headers(): Record<string, string> {
    return { "content-type": "application/json", ...(this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {}), ...this.cfg.headers };
  }

  async stream(req: ModelRequest, signal: AbortSignal, on: StreamHandlers): Promise<ModelReply> {
    const body: Record<string, unknown> = {
      model: this.cfg.model, stream: true, stream_options: { include_usage: true },
      messages: [{ role: "system", content: req.system }, ...req.messages.map(toWire)],
    };
    if (req.tools.length) body.tools = req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
    if (req.effort && this.cfg.reasoning !== "none") { if (this.cfg.effortField === "reasoning") body.reasoning = { effort: req.effort }; else body.reasoning_effort = req.effort; }

    const res = await fetchModel(this.url(), { method: "POST", headers: this.headers(), body: JSON.stringify(body), signal });
    if (!res.ok || !res.body) {
      const detail = (await res.text().catch(() => "")).slice(0, 400);
      throw new ProviderError(`the model endpoint answered ${res.status}${detail ? `: ${detail}` : ""}`, res.status, retryAfterMs(res));
    }

    const reply: ModelReply = { content: "", calls: [], finish: "" };
    const calls = new Map<number, ToolCall>();
    const announced = new Set<number>();
    for await (const data of sseData(res.body)) {
      let json: any;
      try { json = JSON.parse(data); } catch { continue; }
      if (json.usage) reply.usage = { prompt: json.usage.prompt_tokens ?? 0, completion: json.usage.completion_tokens ?? 0 };
      const choice = json.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta ?? {};
      const thought = delta.reasoning_content ?? delta.reasoning;
      if (typeof thought === "string" && thought) on.thought(thought);
      if (typeof delta.content === "string" && delta.content) { reply.content += delta.content; on.text(delta.content); }
      for (const tc of delta.tool_calls ?? []) {
        const index: number = tc.index ?? 0;
        const call = calls.get(index) ?? { id: tc.id || `call_${calls.size + 1}_${Math.random().toString(36).slice(2, 8)}`, name: "", arguments: "" };
        if (tc.id) call.id = tc.id;
        if (tc.function?.name) call.name += tc.function.name;
        if (tc.function?.arguments) call.arguments += tc.function.arguments;
        calls.set(index, call);
        if (call.name && !announced.has(index)) { announced.add(index); on.toolStarted(call.id, call.name); }
      }
      if (choice.finish_reason) reply.finish = choice.finish_reason;
    }
    reply.calls = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c);
    return reply;
  }

  async complete(system: string, user: string, signal: AbortSignal): Promise<string> {
    const res = await fetchModel(this.url(), {
      method: "POST", headers: this.headers(), signal,
      body: JSON.stringify({ model: this.cfg.model, stream: false, messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
    });
    if (!res.ok) throw new ProviderError(`the model endpoint answered ${res.status}`, res.status, retryAfterMs(res));
    const json: any = await res.json();
    const text = json?.choices?.[0]?.message?.content;
    if (typeof text !== "string" || !text.trim()) throw new ProviderError("the model returned an empty answer");
    return text;
  }
}
