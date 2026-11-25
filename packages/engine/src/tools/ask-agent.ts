import { redact } from "../redact.ts";
import type { Tool } from "../types.ts";
import { untrusted } from "./untrusted.ts";
import { clip, outputBudget, str } from "./util.ts";

export const ASK_AGENT_TOOL_NAME = "AskAgent";

/** A model with room is offered the tool whenever the person has set up a peer; a small one only when the request names agents or one of them. */
const mentions = (text: string, names: readonly string[]): boolean => /\bagents?\b/i.test(text) || names.some((n) => text.toLowerCase().includes(n.toLowerCase()));

/** The tool, made only when the person has set up at least one peer. What the peer answers is somebody else's text, so it comes back framed and marks the turn as one that read outside text. */
export function askAgentTool(names: readonly string[]): Tool {
  return {
    name: ASK_AGENT_TOOL_NAME,
    // Not read-only: the message leaves this computer. It is asked about in `ask` mode, and not offered in plan mode.
    readOnly: false,
    offeredWhen: ({ small, userText }) => !small || mentions(userText, names),
    description: "Ask another agent the user has set up and read its answer. It does not see this conversation: say all it needs. context: an id from an earlier answer, to go on with it.",
    parameters: { type: "object", properties: { agent: { type: "string", enum: [...names] }, message: { type: "string" }, context: { type: "string" } }, required: ["agent", "message"] },
    fixArgs: (a) => ({ ...a, agent: a.agent ?? a.peer ?? a.name ?? a.to, message: a.message ?? a.prompt ?? a.question ?? a.text, context: a.context ?? a.context_id ?? a.contextId }),
    title: (a) => `Ask ${str(a.agent)}: ${str(a.message).slice(0, 80)}`,
    async run(a, ctx) {
      const agent = str(a.agent).trim(), message = str(a.message).trim();
      if (!ctx.peers) return "Error: no other agents are set up here.";
      if (!message) return `Error: the message is empty: {"agent": "${ctx.peers.names[0] ?? "name"}", "message": "What port does the service use?"}`;
      if (!ctx.peers.names.includes(agent)) return `Error: there is no agent "${agent}". Use one of: ${ctx.peers.names.join(", ")}.`;
      const context = str(a.context).trim();
      try {
        const answer = await ctx.peers.ask(agent, redact(message), context || undefined, ctx.signal);
        const said = answer.text || "(no text)";
        const note = answer.state === "failed" || answer.state === "rejected" ? "\n[the agent says it could not do this]" : answer.state === "input-required" || answer.state === "auth-required" ? "\n[the agent wants more from the user, which cannot be given from here]" : answer.state === "canceled" ? "\n[the agent stopped before it finished]" : "";
        const heard = clip(said, outputBudget(ctx.window));
        ctx.outside?.(heard);
        return `${untrusted("agent", heard, agent)}${note}${answer.context ? `\ncontext: ${answer.context}` : ""}`;
      } catch (e) {
        if (ctx.signal.aborted) throw e;
        return `Error: ${e instanceof Error ? e.message : "the agent could not be asked"}`;
      }
    },
  };
}
