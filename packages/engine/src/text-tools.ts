import type { Message, Tool } from "./types.ts";

/** The first sentence of a description, cut short: a model that is told its tools in words needs the name, the arguments and one reason to pick it. */
const gist = (text: string): string => {
  const first = text.replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s/)[0] ?? "";
  return first.length > 90 ? `${first.slice(0, 87).trimEnd()}...` : first;
};

/** The arguments a call must have, as a list of names. The optional ones are left out: a small model fills in every argument it is shown, and a tool takes the defaults of the rest. */
const needed = (t: Tool): string => {
  const schema = t.parameters as { properties?: Record<string, unknown>; required?: string[] };
  const required = new Set(schema.required ?? []);
  return Object.keys(schema.properties ?? {}).filter((k) => required.has(k)).join(", ");
};

/**
 * The tools of a model whose server takes none, said in the prompt in the shortest form: one line each, and one example of how to ask for one. The reply is read by
 * `TextToolCalls` (the call as a block of JSON), and a line that starts with `$ ` is the Bash shortcut it already knows.
 */
export function toolsInPrompt(tools: readonly Tool[]): string {
  if (!tools.length) return "";
  const lines = tools.map((t) => `${t.name}: ${gist(t.description)} Arguments: ${needed(t)}.`);
  const first = tools[0]!;
  const sample = JSON.stringify({ name: first.name, arguments: Object.fromEntries(((first.parameters as { required?: string[] }).required ?? []).map((k) => [k, "..."])) });
  return [
    "Tools. To use one, reply with only this and wait for the result:",
    `<tool_call>${sample}</tool_call>`,
    ...lines,
    ...(tools.some((t) => t.name === "Bash") ? ["For a shell command you may also write one line: $ command"] : []),
  ].join("\n");
}

/** The conversation for such a model: a call it made is the text it wrote, and the result of a call is a message of the person, because the server has no place for either. */
export function messagesAsText(messages: readonly Message[]): Message[] {
  const named = new Map<string, string>();
  const out: Message[] = [];
  for (const m of messages) {
    if (m.role === "assistant" && m.toolCalls?.length) {
      for (const c of m.toolCalls) named.set(c.id, c.name);
      const calls = m.toolCalls.map((c) => `<tool_call>${JSON.stringify({ name: c.name, arguments: safe(c.arguments) })}</tool_call>`).join("\n");
      out.push({ role: "assistant", content: [typeof m.content === "string" ? m.content : "", calls].filter(Boolean).join("\n") });
    } else if (m.role === "tool") {
      const text = `Result of ${named.get(m.toolCallId ?? "") ?? "the tool"}:\n${typeof m.content === "string" ? m.content : ""}`;
      const last = out.at(-1);
      if (last?.role === "user" && typeof last.content === "string" && last.content.startsWith("Result of ")) out[out.length - 1] = { ...last, content: `${last.content}\n\n${text}` };
      else out.push({ role: "user", content: text });
    } else out.push(m);
  }
  return out;
}

const safe = (json: string): unknown => { try { return JSON.parse(json); } catch { return {}; } };
