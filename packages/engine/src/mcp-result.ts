/** What a connected program answers, turned into what the model reads: text in the frame for outside text, pictures as pictures, and a limit with a note. */
import type { Part, ToolContext } from "./types.ts";
import { spill } from "./tools/util.ts";
import { untrusted } from "./tools/untrusted.ts";

export type McpContent =
  | { type: "text"; text?: string }
  | { type: "image"; data?: string; mimeType?: string }
  | { type: "audio"; mimeType?: string }
  | { type: "resource"; resource?: { uri?: string; text?: string; blob?: string; mimeType?: string } }
  | { type: "resource_link"; uri?: string; name?: string }
  | { type: string };

export interface McpResult { content?: McpContent[]; isError?: boolean; structuredContent?: unknown }

/** The most a program's answer may bring in one result, in characters. */
export const MCP_MAX = 25_000;
const PICTURE_MAX = 4_000_000;

/** The text of an answer, with a name for what cannot be shown. */
function text(c: McpContent): string {
  const x = c as { text?: string; resource?: { uri?: string; text?: string; blob?: string; mimeType?: string }; uri?: string; name?: string; mimeType?: string };
  if (c.type === "text") return x.text ?? "";
  if (c.type === "resource" && x.resource) return x.resource.text ?? `[${x.resource.mimeType ?? "binary"} resource ${x.resource.uri ?? ""}, ${Math.floor(((x.resource.blob ?? "").length * 3) / 4)} bytes, not shown]`;
  if (c.type === "resource_link") return `[resource ${x.uri ?? ""}${x.name ? ` (${x.name})` : ""}: read it with mcp__resources]`;
  return `[${c.type} omitted]`;
}

/** The pictures go to the model as pictures when it can see them; otherwise they are named. */
function pictures(content: McpContent[], ctx: Pick<ToolContext, "vision" | "show">): string[] {
  const notes: string[] = [];
  for (const c of content) {
    if (c.type !== "image") continue;
    const p = c as { data?: string; mimeType?: string };
    if (!p.data || !p.mimeType?.startsWith("image/")) notes.push("[a picture that could not be read]");
    else if (ctx.vision === false || !ctx.show) notes.push(`[picture, ${p.mimeType}: this model cannot see pictures, so it is not shown]`);
    else if (p.data.length > PICTURE_MAX) notes.push(`[picture, ${p.mimeType}, too large to show (${Math.floor((p.data.length * 3) / 4)} bytes)]`);
    else { ctx.show({ type: "image", mime: p.mimeType, data: p.data } satisfies Part); notes.push(`[picture, ${p.mimeType}: shown below]`); }
  }
  return notes;
}

/** Cuts what is too long, keeps the whole in a file when it can, and says so. */
export function limited(body: string, max = MCP_MAX): string {
  if (body.length <= max) return body;
  const file = spill(body);
  return `${body.slice(0, max)}\n[cut: the answer was ${body.length} characters, ${max} shown${file ? `; all of it is in ${file}` : ""}. Ask the program for less.]`;
}

/** What the model reads for one answer. A failure keeps the `Error:` start every tool failure has. */
export function render(result: McpResult, ctx: Pick<ToolContext, "vision" | "show">): string {
  const content = result.content ?? [];
  const parts = [...content.filter((c) => c.type !== "image").map(text), ...pictures(content, ctx)];
  const body = parts.join("\n").trim() || (result.structuredContent !== undefined ? JSON.stringify(result.structuredContent) : "");
  if (result.isError) return `Error: ${untrusted("tool", limited(body || "the tool reported a failure"))}`;
  return limited(body || "(no output)");
}

/** A plain text of an answer, for callers that only read text (no frame, no pictures). */
export function plain(result: McpResult): string {
  const body = (result.content ?? []).map(text).join("\n").trim();
  return result.isError ? `Error: ${body || "the tool reported a failure"}` : body || "(no output)";
}
