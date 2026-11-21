/**
 * Provider for the responses HTTP API: streaming text, reasoning summaries, tool calls and token usage, with a key and no
 * other program needed. Several model servers and hosted services speak it.
 */
import type { Message, ModelReply, ModelRequest, Part, Provider, StreamHandlers, ToolCall } from "../types.ts";
import type { Credentials } from "../signin.ts";
import { ProviderError } from "./chat-completions.ts";
import { sseData } from "./sse.ts";
import { fetchModel, retryAfterMs, statusOfKind } from "./net.ts";


export interface ResponsesApiConfig {
  /** The service is known to read a PDF given as a file, so the original goes along with its text. */
  readsPdf?: boolean;
  /** A saved sign-in used instead of a key: it gives the headers, and may change the body (some services answer only as a stream). */
  credentials?: Credentials;
  /** Base URL including the version prefix, e.g. `https://api.example.com/v1`. */
  baseUrl: string;
  model: string;
  apiKey?: string;
  headers?: Record<string, string>;
}

type Item = Record<string, unknown>;

/** The levels the API accepts; a higher level of ours asks for the highest it has. */
const LEVEL: Record<string, string> = { minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "high", max: "high" };

const content = (c: Message["content"], text: "input_text" | "output_text"): Item[] =>
  c === undefined ? [] : typeof c === "string" ? (c ? [{ type: text, text: c }] : []) : c.map((p: Part) => (p.type === "text" ? { type: text, text: p.text } : p.type === "file" ? { type: "input_file", filename: p.name, file_data: `data:${p.mime};base64,${p.data}` } : { type: "input_image", image_url: `data:${p.mime};base64,${p.data}` }));

/** The conversation as the API wants it: one item after another, a tool call and its result paired by the call's id. */
export function toInput(messages: Message[]): Item[] {
  const out: Item[] = [];
  for (const m of messages) {
    if (m.role === "tool") out.push({ type: "function_call_output", call_id: m.toolCallId, output: typeof m.content === "string" && m.content ? m.content : "(no output)" });
    else if (m.role === "assistant") {
      const said = content(m.content, "output_text");
      if (said.length) out.push({ type: "message", role: "assistant", content: said });
      for (const c of m.toolCalls ?? []) out.push({ type: "function_call", call_id: c.id, name: c.name, arguments: c.arguments || "{}" });
    } else {
      const said = content(m.content, "input_text");
      if (said.length) out.push({ type: "message", role: "user", content: said });
    }
  }
  return out;
}

export class ResponsesApiProvider implements Provider {
  constructor(private readonly cfg: ResponsesApiConfig) {}
  get readsPdf(): boolean { return this.cfg.readsPdf === true; }

  private url(): string { return `${this.cfg.baseUrl.replace(/\/+$/, "")}/responses`; }
  private async headers(): Promise<Record<string, string>> {
    const login = this.cfg.credentials ? await this.cfg.credentials.headers(new Headers(this.cfg.headers)) : {};
    return { "content-type": "application/json", ...(this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {}), ...this.cfg.headers, ...login };
  }
  private shaped(body: Record<string, unknown>): string { return JSON.stringify(this.cfg.credentials ? this.cfg.credentials.body(body) : body); }

  private async fail(res: Response): Promise<never> {
    const text = await res.text().catch(() => "");
    let detail = text.slice(0, 400);
    try { detail = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? detail; } catch { /* not JSON: keep the text */ }
    throw new ProviderError(`the model endpoint answered ${res.status}${detail ? `: ${detail}` : ""}`, res.status, retryAfterMs(res));
  }

  async stream(req: ModelRequest, signal: AbortSignal, on: StreamHandlers): Promise<ModelReply> {
    const body: Record<string, unknown> = { model: this.cfg.model, instructions: req.system, input: toInput(req.messages), stream: true, store: false };
    if (req.tools.length) body.tools = req.tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters }));
    const level = req.effort ? LEVEL[req.effort] : undefined;
    if (level) body.reasoning = { effort: level, summary: "auto" };

    const res = await fetchModel(this.url(), { method: "POST", headers: await this.headers(), body: this.shaped(body), signal });
    if (!res.ok || !res.body) return this.fail(res);

    const reply: ModelReply = { content: "", calls: [], finish: "" };
    const calls = new Map<string, ToolCall>();
    const order: string[] = [];
    let prompt = 0, completion = 0;
    for await (const data of sseData(res.body)) {
      let event: any;
      try { event = JSON.parse(data); } catch { continue; }
      switch (event.type) {
        case "response.output_item.added": {
          const item = event.item ?? {};
          if (item.type === "function_call") {
            const key = String(item.id ?? item.call_id);
            calls.set(key, { id: String(item.call_id ?? item.id), name: String(item.name ?? ""), arguments: String(item.arguments ?? "") });
            order.push(key);
            on.toolStarted(String(item.call_id ?? item.id), String(item.name ?? ""));
          }
          break;
        }
        case "response.output_text.delta":
          if (event.delta) { reply.content += event.delta; on.text(event.delta); }
          break;
        case "response.reasoning_summary_text.delta":
        case "response.reasoning_text.delta":
          if (event.delta) on.thought(event.delta);
          break;
        case "response.function_call_arguments.delta": {
          const call = calls.get(String(event.item_id));
          if (call) call.arguments += event.delta ?? "";
          break;
        }
        case "response.output_item.done": {
          const item = event.item ?? {};
          const call = item.type === "function_call" ? calls.get(String(item.id ?? item.call_id)) : undefined;
          if (call && typeof item.arguments === "string" && item.arguments) call.arguments = item.arguments;
          break;
        }
        case "response.completed": {
          const u = event.response?.usage ?? {};
          prompt = u.input_tokens ?? 0;
          completion = u.output_tokens ?? 0;
          reply.finish = event.response?.status ?? "completed";
          break;
        }
        case "response.incomplete": reply.finish = event.response?.incomplete_details?.reason ?? "incomplete"; break;
        case "response.failed": throw new ProviderError(`the model endpoint reported an error: ${event.response?.error?.message ?? "unknown"}`, statusOfKind(event.response?.error?.code));
        case "error": throw new ProviderError(`the model endpoint reported an error: ${event.message ?? event.error?.message ?? "unknown"}`, statusOfKind(event.code ?? event.error?.code ?? event.error?.type));
        default: break;
      }
    }
    reply.calls = order.map((k) => calls.get(k)!).filter(Boolean);
    reply.usage = { prompt, completion };
    return reply;
  }

  async complete(system: string, user: string, signal: AbortSignal): Promise<string> {
    // A sign-in that answers only as a stream is asked the same way as a turn, with no tools.
    if (this.cfg.credentials) {
      const said = await this.stream({ system, messages: [{ role: "user", content: user }], tools: [] }, signal, { text() {}, thought() {}, toolStarted() {} });
      if (!said.content.trim()) throw new ProviderError("the model returned an empty answer");
      return said.content;
    }
    const res = await fetchModel(this.url(), {
      method: "POST", headers: await this.headers(), signal,
      body: JSON.stringify({ model: this.cfg.model, instructions: system, input: [{ type: "message", role: "user", content: [{ type: "input_text", text: user }] }], store: false }),
    });
    if (!res.ok) return this.fail(res);
    const json: any = await res.json();
    const text = (json?.output ?? []).filter((i: Item) => i.type === "message").flatMap((i: Item) => (i.content as Item[] | undefined) ?? []).filter((b: Item) => b.type === "output_text").map((b: Item) => String(b.text ?? "")).join("");
    if (!text.trim()) throw new ProviderError("the model returned an empty answer");
    return text;
  }
}
