import type { AgentDef } from "../agents.ts";
import type { Tool } from "../types.ts";
import { clip, str } from "./util.ts";

export const AGENT_TOOL_NAME = "Agent";

/** A helper that researches on its own and reports back, so a long search does not fill the conversation. */
export const agent: Tool = {
  name: AGENT_TOOL_NAME,
  readOnly: true,
  offeredWhen: ({ small }) => !small,
  description: "Hand a research task to a helper that reads and searches on its own and answers with what it found. It cannot change anything. Describe the task completely: the helper does not see this conversation.",
  parameters: { type: "object", properties: { description: { type: "string", description: "a few words saying what it is for" }, prompt: { type: "string", description: "the full task" } }, required: ["prompt"] },
  title: (a) => `Ask a helper: ${str(a.description) || str(a.prompt).slice(0, 80)}`,
  async run(a, ctx) {
    const prompt = str(a.prompt).trim();
    if (!prompt) return "Error: the task is empty.";
    if (!ctx.helper) return "Error: helpers are not available here.";
    return clip(await ctx.helper({ description: str(a.description), prompt }, ctx.signal));
  },
};

/** The same tool when the person defined helpers of their own: the agent may name one, and sees what each is for. */
export function agentTool(defs: readonly AgentDef[]): Tool {
  if (!defs.length) return agent;
  const list = defs.map((d) => `${d.name}: ${d.description}`).join("; ");
  return {
    ...agent,
    description: `${agent.description} Helpers defined by the user (name one in "agent" when its description fits the task): ${list}.`,
    parameters: { type: "object", properties: { description: { type: "string", description: "a few words saying what it is for" }, prompt: { type: "string", description: "the full task" }, agent: { type: "string", enum: defs.map((d) => d.name), description: "the helper to use; leave out for a general research helper" } }, required: ["prompt"] },
    async run(a, ctx) {
      const prompt = str(a.prompt).trim();
      if (!prompt) return "Error: the task is empty.";
      if (!ctx.helper) return "Error: helpers are not available here.";
      const chosen = str(a.agent).trim();
      if (chosen && !defs.some((d) => d.name === chosen)) return `Error: there is no helper "${chosen}". Use one of: ${defs.map((d) => d.name).join(", ")}.`;
      return clip(await ctx.helper({ description: str(a.description), prompt, ...(chosen ? { agent: chosen } : {}) }, ctx.signal));
    },
  };
}
