import { fetchModel, retryAfterMs } from "./net.ts";
/**
 * Provider for the native HTTP API of Ollama. The chat-completions endpoint of Ollama cannot raise the model's memory
 * (it stays at 4096 tokens, and older messages are dropped without a word); this API can, so the engine's window is real.
 */
import { parseLenient } from "../lenient-json.ts";
import type { Message, ModelReply, ModelRequest, Provider, StreamHandlers, ToolCall } from "../types.ts";
import { ProviderError } from "./chat-completions.ts";

export interface OllamaConfig {
  /** The server's address without a path, e.g. `http://127.0.0.1:11434`. */
  baseUrl: string;
  model: string;
  /** How many tokens of conversation the model may hold. Sent with every request, so the server loads the model with it. */
  contextTokens: number;
  headers?: Record<string, string>;
}

type Wire = Record<string, unknown>;

/** The conversation in the shape Ollama wants: images ride along as base64, tool calls carry parsed arguments. */
export function toWire(messages: Message[], system: string): Wire[] {
  const out: Wire[] = [{ role: "system", content: system }];
  const names = new Map<string, string>();
  for (const m of messages) {
    if (m.role === "tool") {
      out.push({ role: "tool", tool_name: names.get(m.toolCallId ?? "") ?? "", content: typeof m.content === "string" && m.content ? m.content : "(no output)" });
      continue;
    }
    const parts = typeof m.content === "string" ? [{ type: "text" as const, text: m.content }] : m.content ?? [];
    const text = parts.map((p) => (p.type === "text" ? p.text : "")).join("");
    const images = parts.flatMap((p) => (p.type === "image" ? [p.data] : []));
    const wire: Wire = { role: m.role, content: text };
    if (images.length) wire.images = images;
    if (m.toolCalls?.length) {
      for (const c of m.toolCalls) names.set(c.id, c.name);
      wire.tool_calls = m.toolCalls.map((c) => ({ function: { name: c.name, arguments: parseLenient(c.arguments) ?? {} } }));
    }
    if (text || images.length || m.toolCalls?.length) out.push(wire);
  }
  return out;
}

export class OllamaProvider implements Provider {
  constructor(private readonly cfg: OllamaConfig) {}

  private url(): string { return `${this.cfg.baseUrl.replace(/\/+$/, "")}/api/chat`; }
  private headers(): Record<string, string> { return { "content-type": "application/json", ...this.cfg.headers }; }

  private async fail(res: Response): Promise<never> {
    const text = await res.text().catch(() => "");
    let detail = text.slice(0, 400);
    try { detail = (JSON.parse(text) as { error?: string }).error ?? detail; } catch { /* not JSON: keep the text */ }
    throw new ProviderError(`the model server answered ${res.status}${detail ? `: ${detail}` : ""}`, res.status, retryAfterMs(res));
  }

  async stream(req: ModelRequest, signal: AbortSignal, on: StreamHandlers): Promise<ModelReply> {
    const body: Wire = { model: this.cfg.model, stream: true, messages: toWire(req.messages, req.system), options: { num_ctx: this.cfg.contextTokens } };
    if (req.tools.length) body.tools = req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));

    const res = await fetchModel(this.url(), { method: "POST", headers: this.headers(), body: JSON.stringify(body), signal });
    if (!res.ok || !res.body) return this.fail(res);

    const reply: ModelReply = { content: "", calls: [], finish: "" };
    const decoder = new TextDecoder();
    let pending = "";
    const handle = (line: string): void => {
      let chunk: any;
      try { chunk = JSON.parse(line); } catch { return; }
      if (chunk.error) throw new ProviderError(`the model server reported an error: ${chunk.error}`);
      const message = chunk.message ?? {};
      if (typeof message.thinking === "string" && message.thinking) on.thought(message.thinking);
      if (typeof message.content === "string" && message.content) { reply.content += message.content; on.text(message.content); }
      for (const call of message.tool_calls ?? []) {
        const name = String(call.function?.name ?? "");
        if (!name) continue;
        const entry: ToolCall = { id: `call_${reply.calls.length + 1}_${Math.random().toString(36).slice(2, 8)}`, name, arguments: JSON.stringify(call.function?.arguments ?? {}) };
        reply.calls.push(entry);
        on.toolStarted(entry.id, name);
      }
      if (chunk.done) {
        reply.finish = String(chunk.done_reason ?? "stop");
        reply.usage = { prompt: Number(chunk.prompt_eval_count) || 0, completion: Number(chunk.eval_count) || 0 };
      }
    };
    for await (const part of res.body as unknown as AsyncIterable<Uint8Array>) {
      pending += decoder.decode(part, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) handle(line);
    }
    if (pending.trim()) handle(pending);
    return reply;
  }

  async complete(system: string, user: string, signal: AbortSignal): Promise<string> {
    const res = await fetchModel(this.url(), {
      method: "POST", headers: this.headers(), signal,
      body: JSON.stringify({ model: this.cfg.model, stream: false, messages: [{ role: "system", content: system }, { role: "user", content: user }], options: { num_ctx: this.cfg.contextTokens } }),
    });
    if (!res.ok) return this.fail(res);
    const json: any = await res.json();
    const text = json?.message?.content;
    if (typeof text !== "string" || !text.trim()) throw new ProviderError("the model returned an empty answer");
    return text;
  }
}
