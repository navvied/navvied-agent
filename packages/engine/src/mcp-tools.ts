/**
 * Turns connected programs into the engine's tools. Every tool is named `mcp__<server>__<tool>`. When the programs bring more than fit in a
 * model's first look, their tools are not listed: one search tool finds them, and what it finds is offered from then on.
 */
import type { McpPromptInfo } from "@navvied/protocol";
import { McpAuthError, McpClient, McpHttpClient, type McpLike, type McpServerConfig } from "./mcp.ts";
import { FIND, type Listed, PROMPTS, RESOURCES, findTool, promptText, promptsTool, resourcesTool } from "./mcp-extras.ts";
import type { OAuthStore } from "./mcp-oauth.ts";
import { render } from "./mcp-result.ts";
import type { Tool } from "./types.ts";

const NAME = /[^A-Za-z0-9_-]/g;
const WORDS = 500;

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

export interface McpConnection {
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
      const client = config.url ? await McpHttpClient.start(name, config, options.store) : await McpClient.start(name, config, track);
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
    close: () => clients.forEach((c) => c.close()),
  };
}

export { FIND, PROMPTS, RESOURCES };
