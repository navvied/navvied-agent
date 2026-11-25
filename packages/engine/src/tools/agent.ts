import type { AgentDef } from "../agents.ts";
import type { Tool } from "../types.ts";
import { clip, outputBudget, str } from "./util.ts";

export const AGENT_TOOL_NAME = "Agent";

const BASE = "Give a research task to a helper that reads alone and reports what it found, with file paths. It does not see this conversation: describe the task fully. background: true returns at once; the answer arrives later.";

/** The tool, with the helpers the person defined (when there are any) named in it. */
export function agentTool(defs: readonly AgentDef[] = []): Tool {
  const names = defs.map((d) => d.name);
  const properties: Record<string, unknown> = { description: { type: "string" }, prompt: { type: "string" }, background: { type: "boolean" } };
  if (defs.length) properties.agent = { type: "string", enum: names };
  return {
    name: AGENT_TOOL_NAME,
    readOnly: true,
    /** A model with room is offered it always (the text is short); a small one only when the person names it. */
    offeredWhen: ({ small, userText }) => !small || /\bagent\b/i.test(userText),
    description: defs.length ? `${BASE} Helpers defined by the user (name one in "agent" when its description fits the task): ${defs.map((d) => `${d.name}: ${d.description}`).join("; ")}.` : BASE,
    parameters: { type: "object", properties, required: ["prompt"] },
    title: (a) => `Ask a helper: ${str(a.description) || str(a.prompt).slice(0, 80)}`,
    async run(a, ctx) {
      const prompt = str(a.prompt).trim();
      if (!prompt) return 'Error: the task is empty: {"prompt": "Find where the retry logic lives and list the files"}';
      if (!ctx.helper) return "Error: helpers are not available here.";
      const chosen = str(a.agent).trim();
      if (chosen && !names.includes(chosen)) return `Error: there is no helper "${chosen}". Use one of: ${names.join(", ") || "none defined"}.`;
      return clip(await ctx.helper({ description: str(a.description), prompt, ...(chosen ? { agent: chosen } : {}), ...(a.background === true ? { background: true } : {}) }, ctx.signal), outputBudget(ctx.window));
    },
  };
}

export const agent: Tool = agentTool();
