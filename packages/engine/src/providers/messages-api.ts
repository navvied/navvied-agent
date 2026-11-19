/**
 * Provider for the messages HTTP API of Anthropic: streaming text, reasoning, tool use and token usage, with an API key
 * and no other program needed.
 */
import { parseLenient } from "../lenient-json.ts";
import type { Message, ModelReply, ModelRequest, Part, Provider, StreamHandlers, ToolCall } from "../types.ts";
import type { Credentials } from "../signin.ts";
import { ProviderError } from "./chat-completions.ts";
import { sseData } from "./sse.ts";
import { fetchModel } from "./net.ts";


export interface MessagesApiConfig {
  /** The service is known to read a PDF given as a file, so the original goes along with its text. */
  readsPdf?: boolean;
  /** A saved sign-in used instead of a key: it gives the headers, and may change the body. */
  credentials?: Credentials;
  /** Base URL including the version prefix, e.g. `https://api.anthropic.com/v1`. */
  baseUrl: string;
  model: string;
  apiKey?: string;
  /** The most the model may write in one answer (default 8192). */
  maxTokens?: number;
  headers?: Record<string, string>;
}

const VERSION = "2023-06-01";
/** The names of the headers this API uses, for a program that passes its calls on. */
export const MESSAGES_HEADERS = { version: "anthropic-version", beta: "anthropic-beta", key: "x-api-key", defaultVersion: VERSION } as const;

type Block = Record<string, unknown>;
type Wire = { role: "user" | "assistant"; content: Block[] };

const part = (p: Part): Block => (p.type === "text" ? { type: "text", text: p.text } : p.type === "file" ? { type: "document", title: p.name, source: { type: "base64", media_type: p.mime, data: p.data } } : { type: "image", source: { type: "base64", media_type: p.mime, data: p.data } });
const blocks = (content: Message["content"]): Block[] => (content === undefined ? [] : typeof content === "string" ? (content ? [{ type: "text", text: content }] : []) : content.map(part));

/**
 * The conversation in the shape the API wants: roles alternate, a tool call is a block inside the assistant's message,
 * and all the results that answer it travel together in the next message from the user.
 */
export function toWire(messages: Message[]): Wire[] {
  const out: Wire[] = [];
  const add = (role: Wire["role"], content: Block[]): void => {
    if (!content.length) return;
    const last = out.at(-1);
    if (last && last.role === role) last.content.push(...content); else out.push({ role, content });
  };
  for (const m of messages) {
    if (m.role === "tool") add("user", [{ type: "tool_result", tool_use_id: m.toolCallId, content: typeof m.content === "string" && m.content ? m.content : "(no output)" }]);
    else if (m.role === "assistant") add("assistant", [...blocks(m.content), ...(m.toolCalls ?? []).map((c): Block => ({ type: "tool_use", id: c.id, name: c.name, input: parseLenient(c.arguments) ?? {} }))]);
    else add("user", blocks(m.content));
  }
  return out;
}

export class MessagesApiProvider implements Provider {
  constructor(private readonly cfg: MessagesApiConfig) {}
  get readsPdf(): boolean { return this.cfg.readsPdf === true; }

  private url(): string { return `${this.cfg.baseUrl.replace(/\/+$/, "")}/messages`; }
  private async headers(): Promise<Record<string, string>> {
    const login = this.cfg.credentials ? await this.cfg.credentials.headers(new Headers(this.cfg.headers)) : {};
    return { "content-type": "application/json", [MESSAGES_HEADERS.version]: VERSION, ...(this.cfg.apiKey ? { [MESSAGES_HEADERS.key]: this.cfg.apiKey } : {}), ...this.cfg.headers, ...login };
  }
  private shaped(body: Record<string, unknown>): string { return JSON.stringify(this.cfg.credentials ? this.cfg.credentials.body(body) : body); }

  private async fail(res: Response): Promise<never> {
    const text = await res.text().catch(() => "");
    let detail = text.slice(0, 400);
    try { detail = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? detail; } catch { /* not JSON: keep the text */ }
    throw new ProviderError(`the model endpoint answered ${res.status}${detail ? `: ${detail}` : ""}`, res.status);
  }

  async stream(req: ModelRequest, signal: AbortSignal, on: StreamHandlers): Promise<ModelReply> {
    const body: Record<string, unknown> = { model: this.cfg.model, max_tokens: this.cfg.maxTokens ?? 8192, stream: true, system: req.system, messages: toWire(req.messages) };
    if (req.tools.length) body.tools = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));

    const res = await fetchModel(this.url(), { method: "POST", headers: await this.headers(), body: this.shaped(body), signal });
    if (!res.ok || !res.body) return this.fail(res);

    const reply: ModelReply = { content: "", calls: [], finish: "" };
    const calls = new Map<number, ToolCall>();
    let prompt = 0, completion = 0;
    for await (const data of sseData(res.body)) {
      let event: any;
      try { event = JSON.parse(data); } catch { continue; }
      switch (event.type) {
        case "message_start": {
          const u = event.message?.usage ?? {};
          prompt = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
          completion = u.output_tokens ?? 0;
          break;
        }
        case "content_block_start": {
          const block = event.content_block ?? {};
          if (block.type === "tool_use") {
            calls.set(event.index, { id: block.id, name: block.name, arguments: "" });
            on.toolStarted(block.id, block.name);
          }
          break;
        }
        case "content_block_delta": {
          const d = event.delta ?? {};
          if (d.type === "text_delta" && d.text) { reply.content += d.text; on.text(d.text); }
          else if (d.type === "thinking_delta" && d.thinking) on.thought(d.thinking);
          else if (d.type === "input_json_delta") { const call = calls.get(event.index); if (call) call.arguments += d.partial_json ?? ""; }
          break;
        }
        case "message_delta":
          if (event.delta?.stop_reason) reply.finish = event.delta.stop_reason;
          if (event.usage?.output_tokens !== undefined) completion = event.usage.output_tokens;
          break;
        case "error":
          throw new ProviderError(`the model endpoint reported an error: ${event.error?.message ?? "unknown"}`);
        default: break;
      }
    }
    reply.calls = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c);
    reply.usage = { prompt, completion };
    return reply;
  }

  async complete(system: string, user: string, signal: AbortSignal): Promise<string> {
    const res = await fetchModel(this.url(), {
      method: "POST", headers: await this.headers(), signal,
      body: this.shaped({ model: this.cfg.model, max_tokens: 4096, system, messages: [{ role: "user", content: user }] }),
    });
    if (!res.ok) return this.fail(res);
    const json: any = await res.json();
    const text = (json?.content ?? []).filter((b: Block) => b.type === "text").map((b: Block) => String(b.text ?? "")).join("");
    if (!text.trim()) throw new ProviderError("the model returned an empty answer");
    return text;
  }
}
