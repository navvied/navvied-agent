import type { Tool } from "../types.ts";
import { remember } from "../memory.ts";
import { str } from "./util.ts";

export const rememberTool: Tool = {
  name: "Remember",
  readOnly: false,
  offeredWhen: ({ userText }) => /\b(remember|memorize|forget|from now on|always|never forget|note that|my preference)\b/i.test(userText),
  description: "Keep one short fact for later conversations: what the user asked you to remember, or a lasting preference. Not a log.",
  parameters: { type: "object", properties: { note: { type: "string" }, scope: { type: "string", enum: ["project", "user"] } }, required: ["note"] },
  title: (a) => `Remember: ${str(a.note).slice(0, 120)}`,
  async run(a, ctx) {
    if (!ctx.memory) return "Error: memory is not available here.";
    return remember(ctx.memory, a.scope === "user" ? "user" : "project", str(a.note), new Date().toISOString().slice(0, 10));
  },
};
