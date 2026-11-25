import type { Tool } from "./mcp.ts";

interface Prop { type?: unknown; enum?: unknown[]; description?: string }
type Schema = { properties?: Record<string, Prop>; required?: string[] };

const shape = (p: Prop): string => (Array.isArray(p.enum) && p.enum.length ? p.enum.map(String).join("|") : Array.isArray(p.type) ? p.type.join("|") : String(p.type ?? "any"));

/** One line per tool: its name, then each property as `name:shape`, required ones starred. What a person reads to see what a driver offers without opening its schemas. */
export function describeTools(tools: Tool[]): string {
  return tools.map((t) => {
    const s = (t.inputSchema ?? {}) as Schema;
    const need = new Set(s.required ?? []);
    const props = Object.entries(s.properties ?? {}).map(([k, p]) => `${k}${need.has(k) ? "*" : ""}:${shape(p)}`);
    return `${t.name}(${props.join(", ")})`;
  }).join("\n");
}
