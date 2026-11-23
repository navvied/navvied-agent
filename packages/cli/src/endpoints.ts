import type { EndpointModel, EndpointSaved } from "@navvied/protocol";
import type { ModelEntry } from "./config.ts";
import { largestContext } from "./fit.ts";
import type { ModelShape } from "./gguf.ts";
import type { Machine } from "./machine.ts";

/** A server of the person's own: where it is, how it is spoken, the key it takes (kept only here), and the models to use. */
export interface EndpointRecord { name: string; baseUrl: string; api: "chat" | "responses" | "messages" | "ollama"; key?: string; models: EndpointModel[] }

const slug = (text: string): string => text.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "model";

/** The id of a new endpoint: made from its name, and never one that is taken. */
export function newEndpointId(name: string, taken: readonly string[]): string {
  const base = `custom-${slug(name).replace(/[._]/g, "-")}`.slice(0, 40);
  let id = base;
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`;
  return id;
}

/** The names the models of an endpoint have in the configuration: one each, made from the endpoint and the model, each different from the others. */
export function modelNames(id: string, models: readonly EndpointModel[]): Map<string, string> {
  const out = new Map<string, string>();
  const used = new Set<string>();
  for (const m of models) {
    let name = `${id}-${slug(m.id)}`;
    for (let n = 2; used.has(name); n++) name = `${id}-${slug(m.id)}-${n}`;
    used.add(name);
    out.set(m.id, name);
  }
  return out;
}

/** The entry of the configuration a model made from an endpoint holds: no key, no address, only which endpoint and which of its models. */
export const endpointModel = (id: string, e: EndpointRecord, m: EndpointModel): ModelEntry => ({ endpoint: id, model: m.id, display: { name: m.id, brand: e.name } });

/** The entry a model of an endpoint stands for right now: the address, the key and what is known of the model are read here, never copied into the model. */
export function expandEndpointModel(endpoints: Record<string, EndpointRecord> | undefined, m: ModelEntry): { entry: ModelEntry } | { error: string } {
  const e = m.endpoint ? endpoints?.[m.endpoint] : undefined;
  if (!e) return { error: "That endpoint is not there any more." };
  const listed = e.models.find((x) => x.id === m.model);
  if (!listed) return { error: `${e.name} no longer lists ${m.model}.` };
  const { endpoint: _e, ...own } = m;
  return { entry: { ...own, baseUrl: e.baseUrl, api: e.api, ...(e.key ? { apiKey: e.key } : {}), ...(listed.window ? { window: listed.window } : {}), ...(listed.vision !== undefined ? { vision: listed.vision } : {}), ...(listed.pdf !== undefined ? { pdf: listed.pdf } : {}) } };
}

/** What may be said of the endpoints: everything but the key, which is only said to be there. */
export const reportEndpoints = (endpoints: Record<string, EndpointRecord> | undefined): EndpointSaved[] =>
  Object.entries(endpoints ?? {}).map(([id, e]) => ({ id, name: e.name, baseUrl: e.baseUrl, api: e.api, key: !!e.key, models: e.models }));

/**
 * The size of memory a server says for a model in its list of models, when it does. Only names that a line of the server's own source or docs shows on `GET /models`
 * (raw lines in the evidence notes): `max_model_len` (vLLM), `meta.n_ctx` (llama.cpp: the size it runs with, not the one the model was trained for),
 * `context_length` (OpenRouter-style) and `limit.context` (OpenCode). Ollama and LM Studio's own lists do not carry it on these routes.
 */
function windowOf(m: Record<string, unknown>): number | undefined {
  const limit = m.limit as { context?: unknown } | undefined;
  const meta = m.meta as { n_ctx?: unknown } | undefined;
  for (const v of [m.context_length, m.max_model_len, meta?.n_ctx, limit?.context]) if (typeof v === "number" && Number.isInteger(v) && v > 0) return v;
  return undefined;
}

export type EndpointApi = EndpointRecord["api"];
type Listed = { items: { id: string; window?: number }[] };
type Answer = { status: number; body?: Record<string, unknown> } | { unreachable: true };

async function get(fetchFn: typeof fetch, url: string, headers: Record<string, string>): Promise<Answer> {
  try {
    const res = await fetchFn(url, { headers, signal: AbortSignal.timeout(8000) });
    const body = res.ok ? ((await res.json().catch(() => undefined)) as Record<string, unknown> | undefined) : undefined;
    return { status: res.status, ...(body && typeof body === "object" ? { body } : {}) };
  } catch { return { unreachable: true }; }
}

const itemsOf = (body: Record<string, unknown> | undefined, ollama: boolean): Listed["items"] => {
  const raw = (ollama ? body?.models : body?.data) as Record<string, unknown>[] | undefined;
  if (!Array.isArray(raw)) return [];
  return raw.map((m) => (ollama ? { ...m, id: m.name } : m)).filter((m) => m && typeof m.id === "string" && m.id).map((m) => ({ id: m.id as string, ...(windowOf(m) ? { window: windowOf(m)! } : {}) })).sort((a, b) => a.id.localeCompare(b.id));
};

/**
 * What the two local servers whose list of models carries no memory size say elsewhere, as the size the server will really use:
 * LM Studio keeps the size a model was loaded with (`GET /api/v1/models`, `loaded_instances[].config.context_length`): a model that is not loaded has none said, so none is given;
 * Ollama is sent the size we ask for, so it is the largest that fits in the memory this computer has free (`largestContext`, from the model's shape in `POST /api/show` and its
 * file size in `/api/tags`), never more than the model supports.
 */
async function sizesFromLocalServers(fetchFn: typeof fetch, origin: string, ids: string[], headers: Record<string, string>, machineOf: (() => Promise<Machine>) | undefined): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const lm = await get(fetchFn, `${origin}/api/v1/models`, headers);
  if (!("unreachable" in lm) && lm.body && Array.isArray(lm.body.models)) {
    for (const m of lm.body.models as { key?: unknown; loaded_instances?: { config?: { context_length?: unknown } }[] }[]) {
      const n = m?.loaded_instances?.[0]?.config?.context_length;
      if (typeof m?.key === "string" && typeof n === "number" && n > 0) out.set(m.key, n);
    }
    return out;
  }
  if (!machineOf) return out;
  const tags = await get(fetchFn, `${origin}/api/tags`, headers);
  const sizes = new Map<string, number>();
  if (!("unreachable" in tags) && Array.isArray(tags.body?.models)) for (const m of tags.body!.models as { name?: unknown; size?: unknown }[]) if (typeof m?.name === "string" && typeof m.size === "number") sizes.set(m.name, m.size);
  let machine: Machine | undefined;
  const show = async (id: string): Promise<number | undefined> => {
    const bytes = sizes.get(id);
    if (!bytes) return undefined;
    try {
      const res = await fetchFn(`${origin}/api/show`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ model: id }), signal: AbortSignal.timeout(5000) });
      if (!res.ok) return undefined;
      const info = ((await res.json()) as { model_info?: Record<string, unknown> }).model_info ?? {};
      const arch = typeof info["general.architecture"] === "string" ? info["general.architecture"] : undefined;
      const num = (k: string): number | undefined => { const v = arch ? info[`${arch}.${k}`] : undefined; return typeof v === "number" && v > 0 ? v : undefined; };
      const layers = num("block_count"), heads = num("attention.head_count"), embed = num("embedding_length"), supported = num("context_length");
      if (!layers || !heads || !embed || !supported) return undefined;
      const kv = num("attention.head_count_kv") ?? heads;
      const shape: ModelShape = { architecture: arch!, layers, kvHeads: Array(layers).fill(kv), keyLength: num("attention.key_length") ?? Math.floor(embed / heads), valueLength: num("attention.value_length") ?? Math.floor(embed / heads), contextLength: supported };
      machine ??= await machineOf();
      return largestContext(bytes, shape, supported, machine);
    } catch { return undefined; }
  };
  // One call per model, a few at a time, and no more than a screen of them.
  const rest = ids.slice(0, 60);
  for (let i = 0; i < rest.length; i += 6) await Promise.all(rest.slice(i, i + 6).map(async (id) => { const n = await show(id); if (n) out.set(id, n); }));
  return out;
}

/** The models a server lists, asked in the way it is spoken: also the answer to "does this address work with this key". One sentence says what went wrong. */
export async function askModels(fetchFn: typeof fetch, input: { baseUrl: string; api: EndpointApi; headers: Record<string, string>; machine?: () => Promise<Machine> }): Promise<Listed | { error: string }> {
  const root = input.baseUrl.replace(/\/+$/, "");
  const got = await get(fetchFn, input.api === "ollama" ? `${root}/api/tags` : `${root}/models`, input.headers);
  if ("unreachable" in got) return { error: "The server could not be reached." };
  if (got.status === 401 || got.status === 403) return { error: "The server did not accept the key." };
  if (got.status === 404 || got.status === 405) return { error: "The server has no list of models: type the name of the model." };
  if (got.status < 200 || got.status > 299) return { error: `The server answered ${got.status}.` };
  const items = itemsOf(got.body, input.api === "ollama");
  if (!items.length) return { error: "The server sent no list of models: type the name of the model." };
  // A list that does not say the memory size: the two local servers say it elsewhere.
  if (items.some((m) => m.window === undefined)) {
    let origin = "";
    try { origin = new URL(input.baseUrl).origin; } catch { /* the form checks the address */ }
    const sizes = origin ? await sizesFromLocalServers(fetchFn, origin, items.filter((m) => m.window === undefined).map((m) => m.id), input.headers, input.machine) : new Map<string, number>();
    for (const m of items) if (m.window === undefined && sizes.has(m.id)) m.window = sizes.get(m.id)!;
  }
  return { items };
}

/** Which of the two styles that share `GET /models` an answer is in: the messages style's list says it has more pages and its items are typed `model`. */
const sharedStyle = (body: Record<string, unknown>): "chat" | "messages" => (typeof body.has_more === "boolean" || (Array.isArray(body.data) && (body.data as { type?: unknown }[]).some((m) => m?.type === "model")) ? "messages" : "chat");

/** A list whose models all say they are reached through responses and through no chat route. */
const serverSaysResponses = (body: Record<string, unknown>): boolean => {
  const data = Array.isArray(body.data) ? (body.data as { api?: Record<string, unknown> }[]) : [];
  return data.length > 0 && data.every((m) => m?.api && typeof m.api === "object" && "responses" in m.api && !("chat-completions" in m.api));
};

/**
 * The way a server is spoken, found by asking it: the list of models is asked in each style and the one that answers with a list is taken. The list at `/models`
 * says which of the two styles that share it the server speaks (a path that names the messages style settles one that could be either); chat is taken unless the
 * server's own list says that its models are reached through responses only. Never a guess from the address alone: when nothing answers, the sentence says what was tried.
 * `styles` names each style for a person, and says which path or port is a hint of it (data of presets.ts).
 */
export interface ApiStyle { label: string; path?: RegExp; port?: string }

export async function detectApi(fetchFn: typeof fetch, baseUrl: string, headersFor: (api: EndpointApi) => Record<string, string>, styles: Record<EndpointApi, ApiStyle>): Promise<(Listed & { api: EndpointApi }) | { error: string }> {
  const root = baseUrl.replace(/\/+$/, "");
  let path = "", port = "";
  try { const u = new URL(baseUrl); path = u.pathname; port = u.port; } catch { /* the form checks the address */ }
  const hinted = (["messages", "ollama", "responses", "chat"] as const).find((a) => (styles[a].path?.test(path) ?? false) || (styles[a].port !== undefined && styles[a].port === port));
  const shared = await get(fetchFn, `${root}/models`, { ...headersFor("chat"), ...headersFor("messages") });
  const tags = () => get(fetchFn, `${root}/api/tags`, headersFor("ollama"));
  const fromShared = (): (Listed & { api: EndpointApi }) | undefined => {
    if ("unreachable" in shared || !shared.body) return undefined;
    const items = itemsOf(shared.body, false);
    if (!items.length) return undefined;
    const style = sharedStyle(shared.body);
    return { api: style === "chat" ? (hinted === "messages" ? "messages" : serverSaysResponses(shared.body) ? "responses" : "chat") : style, items };
  };
  const fromTags = async (): Promise<(Listed & { api: EndpointApi }) | undefined> => {
    const t = await tags();
    if ("unreachable" in t || !t.body) return undefined;
    const items = itemsOf(t.body, true);
    return items.length ? { api: "ollama", items } : undefined;
  };
  const order = hinted === "ollama" ? [fromTags, async () => fromShared()] : [async () => fromShared(), fromTags];
  for (const find of order) { const found = await find(); if (found) return found; }
  if ("unreachable" in shared) return { error: "The server could not be reached." };
  if (shared.status === 401 || shared.status === 403) return { error: "The server did not accept the key." };
  return { error: `The server did not answer with a list of models in the ${styles.chat.label}, ${styles.messages.label} or ${styles.ollama.label} style (tried /models and /api/tags): choose how it is spoken, and type the name of the model.` };
}
