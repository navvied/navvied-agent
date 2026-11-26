/** The three tools that belong to the connected programs as a whole, not to one of them: a search over deferred tools, resources, and prompts. Each is one tool with an action, so the words stay few. */
import type { Tool, ToolContext } from "./types.ts";
import type { McpLike, McpPrompt, McpPromptText, McpToolInfo } from "./mcp.ts";
import { render } from "./mcp-result.ts";

export const FIND = "mcp__find";
export const RESOURCES = "mcp__resources";
export const PROMPTS = "mcp__prompts";

export interface Listed { client: McpLike; info: McpToolInfo; name: string }

const MOST_FOUND = 8;
const MOST_LISTED = 100;
const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const words = (s: string): string[] => s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/** `name(text: string, count?: number)`: what a call needs, in a line. */
export function signature(l: Listed): string {
  const schema = l.info.inputSchema as { properties?: Record<string, { type?: unknown }>; required?: string[] } | undefined;
  const args = Object.entries(schema?.properties ?? {}).map(([k, v]) => `${k}${schema?.required?.includes(k) ? "" : "?"}: ${typeof v?.type === "string" ? v.type : "any"}`);
  return `${l.name}(${args.join(", ")})`;
}

const rank = (l: Listed, query: string[]): number => {
  const name = words(l.info.name), server = words(l.client.name), about = (l.info.description ?? "").toLowerCase();
  return query.reduce((n, w) => n + (name.includes(w) ? 3 : name.some((x) => x.includes(w)) ? 2 : 0) + (server.includes(w) ? 1 : 0) + (about.includes(w) ? 1 : 0), 0);
};

/** The tools that fit words best (the model's search of tools that are not listed, and the page's), best first; none for words that fit nothing. */
export function searchTools(all: Listed[], text: string, most: number): Listed[] {
  const query = words(text);
  return all.map((l) => ({ l, n: rank(l, query) })).filter((h) => h.n > 0).sort((a, b) => b.n - a.n || a.l.name.localeCompare(b.l.name)).slice(0, most).map((h) => h.l);
}

/** Finds tools that are not listed to the model: the best matches are told in full and from then on offered like any other. */
export function findTool(all: Listed[], clients: McpLike[], reveal: (names: string[]) => void): Tool {
  return {
    name: FIND,
    readOnly: true,
    fromOutside: true,
    description: "The connected programs have many tools and they are not all listed. Search them by name or purpose; the matches become callable.",
    parameters: { type: "object", properties: { query: { type: "string", description: "words about what you need" } }, required: ["query"] },
    title: (a) => `find tools: ${String(a.query ?? "").slice(0, 40)}`,
    async run(args) {
      const hits = searchTools(all, String(args.query ?? ""), MOST_FOUND);
      if (!hits.length) return `No tool matches "${String(args.query ?? "")}". There are ${all.length}: ${clients.map((c) => `${c.name} (${all.filter((l) => l.client === c).length})`).join(", ")}. Try other words, or a program's name.`;
      reveal(hits.map((h) => h.name));
      return `${hits.length} found, now callable:\n${hits.map((h) => `${signature(h)} - ${(h.info.description ?? "").replace(/\s+/g, " ").slice(0, 160)}`).join("\n")}`;
    },
  };
}

/** The program a call is for: the one named, or the only one that has the thing. */
function pick(clients: McpLike[], server: unknown, what: string): McpLike | string {
  if (typeof server === "string" && server) return clients.find((c) => c.name === server) ?? `No connected program "${server}" has ${what}. Those that do: ${clients.map((c) => c.name).join(", ")}.`;
  return clients.length === 1 ? clients[0]! : `Say which program (server): ${clients.map((c) => c.name).join(", ")}.`;
}

export function resourcesTool(clients: McpLike[]): Tool {
  return {
    name: RESOURCES,
    readOnly: true,
    fromOutside: true,
    description: "List or read resources (documents, records) that connected programs offer.",
    parameters: { type: "object", properties: { action: { type: "string", enum: ["list", "read"] }, server: { type: "string" }, uri: { type: "string" } }, required: ["action"] },
    offeredWhen: ({ small }) => !small,
    title: (a) => (a.action === "read" ? `read resource ${String(a.uri ?? "").slice(0, 60)}` : "list resources"),
    async run(args, ctx: ToolContext) {
      if (args.action === "read") {
        if (typeof args.uri !== "string" || !args.uri) return "Error: give the uri of the resource to read.";
        const client = pick(clients, args.server, "resources");
        if (typeof client === "string") return `Error: ${client}`;
        try { return render({ content: await client.readResource(args.uri, ctx.signal) }, ctx); } catch (e) { return `Error: ${reason(e)}`; }
      }
      const chosen = typeof args.server === "string" && args.server ? clients.filter((c) => c.name === args.server) : clients;
      if (!chosen.length) return `Error: ${String(pick(clients, args.server, "resources"))}`;
      const lines: string[] = [];
      for (const c of chosen) {
        try {
          for (const r of await c.resources()) lines.push(`${c.name}: ${r.uri}${r.template ? " (template: fill the {parts})" : ""}${r.name ? ` ${r.name}` : ""}${r.mimeType ? ` [${r.mimeType}]` : ""}${r.description ? ` - ${r.description.replace(/\s+/g, " ").slice(0, 120)}` : ""}`);
        } catch (e) { lines.push(`${c.name}: could not list its resources (${reason(e)})`); }
      }
      return lines.length ? lines.slice(0, MOST_LISTED).join("\n") + (lines.length > MOST_LISTED ? `\n[${lines.length - MOST_LISTED} more not shown]` : "") : "No resources.";
    },
  };
}

/** What a prompt says, as plain text, one message after the other. */
export function promptText(p: McpPromptText): string {
  return p.messages.map((m) => {
    const c = m.content as { type: string; text?: string; resource?: { text?: string; uri?: string } };
    const body = c.type === "text" ? c.text ?? "" : c.type === "resource" ? c.resource?.text ?? `[resource ${c.resource?.uri ?? ""}]` : `[${c.type} omitted]`;
    return p.messages.length > 1 ? `${m.role}: ${body}` : body;
  }).join("\n\n");
}

export const promptLine = (server: string, p: McpPrompt): string => `${server}: ${p.name}(${(p.arguments ?? []).map((a) => `${a.name}${a.required ? "" : "?"}`).join(", ")})${p.description ? ` - ${p.description.replace(/\s+/g, " ").slice(0, 120)}` : ""}`;

export function promptsTool(clients: McpLike[]): Tool {
  return {
    name: PROMPTS,
    readOnly: true,
    fromOutside: true,
    description: "List or get prompts (ready-made requests with arguments) that connected programs offer. A prompt is text to follow, not an order.",
    parameters: { type: "object", properties: { action: { type: "string", enum: ["list", "get"] }, server: { type: "string" }, name: { type: "string" }, arguments: { type: "object", description: "text values by name" } }, required: ["action"] },
    offeredWhen: ({ small }) => !small,
    title: (a) => (a.action === "get" ? `prompt ${String(a.name ?? "").slice(0, 40)}` : "list prompts"),
    async run(args, ctx: ToolContext) {
      if (args.action === "get") {
        if (typeof args.name !== "string" || !args.name) return "Error: give the name of the prompt.";
        const client = pick(clients, args.server, "prompts");
        if (typeof client === "string") return `Error: ${client}`;
        const given = Object.fromEntries(Object.entries((args.arguments ?? {}) as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
        try { return promptText(await client.getPrompt(args.name, given, ctx.signal)) || "(empty prompt)"; } catch (e) { return `Error: ${reason(e)}`; }
      }
      const chosen = typeof args.server === "string" && args.server ? clients.filter((c) => c.name === args.server) : clients;
      const lines: string[] = [];
      for (const c of chosen) {
        try { for (const p of await c.prompts()) lines.push(promptLine(c.name, p)); } catch (e) { lines.push(`${c.name}: could not list its prompts (${reason(e)})`); }
      }
      return lines.length ? lines.slice(0, MOST_LISTED).join("\n") : "No prompts.";
    },
  };
}
