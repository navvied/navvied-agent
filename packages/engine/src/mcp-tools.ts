/**
 * Turns connected programs into the engine's tools. Every tool is named `mcp__<server>__<tool>`. When the programs bring more than fit in a
 * model's first look, their tools are not listed: one search tool finds them, and what it finds is offered from then on.
 */
import type { McpPromptInfo, McpResourceContent, McpResourceInfo, McpToolFound } from "@navvied/protocol";
import { McpAuthError, McpClient, McpHttpClient, type McpLike, type McpServerConfig } from "./mcp.ts";
import { FIND, type Listed, PROMPTS, RESOURCES, findTool, promptText, promptsTool, resourcesTool, searchTools, signature } from "./mcp-extras.ts";
import type { McpHost } from "./mcp-host.ts";
import type { OAuthStore } from "./mcp-oauth.ts";
import { render, type McpContent } from "./mcp-result.ts";
import type { Tool } from "./types.ts";

const NAME = /[^A-Za-z0-9_-]/g;
const WORDS = 500;
const MOST_TOOLS = 50;
const MOST_RESOURCES = 200;
const MOST_TEXT = 1_000_000;
const MOST_DATA = 2_000_000;

/** One part of a document, for a page: its text (cut), or its bytes as base64 when they are not too many. */
function partOf(c: McpContent): McpResourceContent {
  const x = c as { text?: string; data?: string; mimeType?: string; resource?: { uri?: string; text?: string; blob?: string; mimeType?: string } };
  const r = x.resource;
  const mime = r?.mimeType ?? x.mimeType;
  const text = c.type === "text" ? x.text : r?.text;
  if (text !== undefined) return { ...(r?.uri ? { uri: r.uri } : {}), ...(mime ? { mime } : {}), bytes: Buffer.byteLength(text), text: text.slice(0, MOST_TEXT), ...(text.length > MOST_TEXT ? { truncated: true as const } : {}) };
  const data = c.type === "image" ? x.data : r?.blob;
  const bytes = Math.floor(((data ?? "").length * 3) / 4) - (data?.endsWith("==") ? 2 : data?.endsWith("=") ? 1 : 0);
  return { ...(r?.uri ? { uri: r.uri } : {}), ...(mime ? { mime } : {}), bytes, ...(data && bytes <= MOST_DATA ? { data } : data ? { truncated: true as const } : {}) };
}

/** How much the programs may put in front of a model before their tools are searched instead of listed. */
export interface DeferLimit { tools: number; /** Characters of names, descriptions and schemas. */ chars: number }

/** About a twentieth of the window (at four characters a token), and fewer tools for a small model, which loses its way among many. */
export function deferLimit(small: boolean, window?: number): DeferLimit {
  return { tools: small ? 10 : 30, chars: Math.max(4000, Math.floor((window ?? (small ? 32_000 : 128_000)) * 0.2)) };
}

const toolName = (server: string, tool: string): string => `mcp__${server.replace(NAME, "_")}__${tool.replace(NAME, "_")}`.slice(0, 64);

/** What offering a tool costs the model. */
const weight = (l: Listed): number => JSON.stringify({ name: l.name, description: (l.info.description ?? "").slice(0, WORDS), parameters: l.info.inputSchema ?? {} }).length;

function toTool(l: Listed, small: boolean): Tool {
  const { client, info, name } = l;
  const schema = info.inputSchema && typeof info.inputSchema === "object" ? info.inputSchema : {};
  return {
    name,
    readOnly: info.annotations?.readOnlyHint === true,
    fromOutside: true,
    description: `${(info.description ?? "").slice(0, WORDS)} (from the connected program "${client.name}")`.trim(),
    parameters: { type: "object", ...schema, properties: (schema.properties as Record<string, unknown> | undefined) ?? {} },
    offeredWhen: ({ small: tight, userText }) => !(small && tight) || userText.toLowerCase().includes(client.name.toLowerCase()) || userText.toLowerCase().includes(info.name.toLowerCase()),
    title: () => `${client.name}: ${info.name.replace(/[_-]+/g, " ")}`,
    async run(args, ctx) {
      try { return render(await client.callTool(info.name, args, ctx.signal), ctx); }
      catch (e) { return `Error: ${e instanceof Error ? e.message : String(e)}`; }
    },
  };
}

/** What a page may ask of the connected programs besides their prompts: their documents, and their tools by words. */
export interface McpBrowse {
  /** The documents the programs offer (of one program, or all); a program that could not list them is in `problems`. */
  resources(server?: string): Promise<{ items: McpResourceInfo[]; problems: { server: string; reason: string }[] }>;
  /** One document of a program, as parts a page can show. */
  readResource(server: string, uri: string, signal: AbortSignal): Promise<McpResourceContent[]>;
  /** The tools that fit the words (the first `MOST_TOOLS` by name without words), and how many tools there are. */
  find(query?: string, server?: string): { items: McpToolFound[]; total: number };
}

export interface McpConnection extends McpBrowse {
  tools: Tool[];
  /** Servers that could not be used, with the reason in plain words. `signin`: the server wants the person to sign in. */
  problems: { server: string; reason: string; signin?: true }[];
  /** The prompts the programs offer, for a person to pick. */
  prompts(): Promise<McpPromptInfo[]>;
  /** The text of one prompt with its arguments filled in, to be sent as the person's own request. */
  prompt(server: string, name: string, args: Record<string, string>, signal: AbortSignal): Promise<string>;
  close(): void;
}

export interface McpOptions {
  /** The model's window in tokens: what its first look can take. */
  window?: number;
  /** Where the tokens of servers that sign in are kept. */
  store?: OAuthStore;
  /** Replaces the limit from which tools are searched instead of listed. */
  defer?: DeferLimit;
  /** What the programs may ask of this side (a model answer, a question for the person). Without it nothing of that is offered to them. */
  host?: McpHost;
}

/**
 * Starts every configured server at once. One that fails does not stop the others. When `until` aborts (the engine was closed),
 * every program already started is stopped, also one still being connected: it would otherwise run on with nobody to close it.
 */
export async function connectMcp(servers: Record<string, McpServerConfig>, small = false, until?: AbortSignal, options: McpOptions = {}): Promise<McpConnection> {
  const clients: McpLike[] = [];
  let over = until?.aborted ?? false;
  until?.addEventListener("abort", () => { over = true; clients.forEach((c) => c.close()); }, { once: true });
  const track = (c: McpLike): void => { clients.push(c); if (over) c.close(); };
  const listed: Listed[] = [];
  const problems: McpConnection["problems"] = [];
  await Promise.all(Object.entries(servers).map(async ([name, config]) => {
    try {
      const handlers = options.host?.handlers(name, config);
      const client = config.url ? await McpHttpClient.start(name, config, options.store, handlers) : await McpClient.start(name, config, track, handlers);
      if (config.url) track(client);
      const seen = new Set<string>();
      for (const info of await client.tools()) {
        const full = toolName(name, info.name);
        if (!seen.has(full)) { seen.add(full); listed.push({ client, info, name: full }); }
      }
    } catch (e) { problems.push({ server: name, reason: e instanceof Error ? e.message : String(e), ...(e instanceof McpAuthError && e.signin ? { signin: true as const } : {}) }); }
  }));

  const limit = options.defer ?? deferLimit(small, options.window);
  const deferred = listed.length > limit.tools || listed.reduce((n, l) => n + weight(l), 0) > limit.chars;
  const revealed = new Set<string>();
  const live = clients.filter((c) => listed.some((l) => l.client === c) || c.capabilities.resources || c.capabilities.prompts);
  const tools: Tool[] = listed.map((l) => {
    const t = toTool(l, small);
    return deferred ? { ...t, offeredWhen: () => revealed.has(l.name) } : t;
  });
  if (deferred) tools.push(findTool(listed, live, (names) => names.forEach((n) => revealed.add(n))));
  const withResources = clients.filter((c) => c.capabilities.resources), withPrompts = clients.filter((c) => c.capabilities.prompts);
  if (withResources.length) tools.push(resourcesTool(withResources));
  if (withPrompts.length) tools.push(promptsTool(withPrompts));

  return {
    tools,
    problems,
    async prompts() {
      const all: McpPromptInfo[] = [];
      for (const c of withPrompts) for (const p of await c.prompts().catch(() => [])) all.push({ server: c.name, name: p.name, ...(p.description ? { description: p.description } : {}), ...(p.arguments?.length ? { arguments: p.arguments.map((a) => ({ name: a.name, ...(a.description ? { description: a.description } : {}), ...(a.required ? { required: true as const } : {}) })) } : {}) });
      return all;
    },
    async prompt(server, name, args, signal) {
      const client = withPrompts.find((c) => c.name === server);
      if (!client) throw new Error(`the connected program "${server}" has no prompts`);
      return promptText(await client.getPrompt(name, args, signal));
    },
    async resources(server) {
      const items: McpResourceInfo[] = [], problems: { server: string; reason: string }[] = [];
      for (const c of withResources.filter((x) => !server || x.name === server)) {
        try { for (const r of await c.resources()) items.push({ server: c.name, uri: r.uri, ...(r.name ? { name: r.name } : {}), ...(r.description ? { description: r.description.slice(0, 300) } : {}), ...(r.mimeType ? { mimeType: r.mimeType } : {}), ...(r.template ? { template: true as const } : {}) }); }
        catch (e) { problems.push({ server: c.name, reason: e instanceof Error ? e.message : String(e) }); }
      }
      return { items: items.slice(0, MOST_RESOURCES), problems };
    },
    async readResource(server, uri, signal) {
      const client = withResources.find((c) => c.name === server);
      if (!client) throw new Error(`the connected program "${server}" has no documents`);
      return (await client.readResource(uri, signal)).map(partOf);
    },
    find(query, server) {
      const pool = listed.filter((l) => !server || l.client.name === server);
      const hits = query?.trim() ? searchTools(pool, query, MOST_TOOLS) : [...pool].sort((a, b) => a.name.localeCompare(b.name)).slice(0, MOST_TOOLS);
      return { items: hits.map((l) => ({ server: l.client.name, name: l.name, tool: l.info.name, description: (l.info.description ?? "").replace(/\s+/g, " ").slice(0, 300), signature: signature(l) })), total: pool.length };
    },
    close: () => clients.forEach((c) => c.close()),
  };
}

export { FIND, PROMPTS, RESOURCES };
