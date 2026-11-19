import type { Tool } from "../types.ts";
import { remember } from "../memory.ts";
import { str } from "./util.ts";

export const rememberTool: Tool = {
  name: "Remember",
  readOnly: false,
  offeredWhen: ({ small, userText }) => !small || /\b(remember|from now on|always|never forget|note that)\b/i.test(userText),
  description: "Keep one short fact for later conversations: something the user told you to remember, or a lasting preference or rule you learned. Not a log of what you did.",
  parameters: { type: "object", properties: { note: { type: "string", description: "one fact, in one sentence" }, scope: { type: "string", enum: ["project", "user"], description: "project (default) or every project" } }, required: ["note"] },
  title: (a) => `Remember: ${str(a.note).slice(0, 120)}`,
  async run(a, ctx) {
    if (!ctx.memory) return "Error: memory is not available here.";
    return remember(ctx.memory, a.scope === "user" ? "user" : "project", str(a.note), new Date().toISOString().slice(0, 10));
  },
};
