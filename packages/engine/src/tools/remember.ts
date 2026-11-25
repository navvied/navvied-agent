import type { Tool } from "../types.ts";
import { keep, type MemoryOp, type Scope } from "../memory.ts";
import { str } from "./util.ts";

export const rememberTool: Tool = {
  name: "Remember",
  readOnly: false,
  // Not offered on words alone: a note can be saved in any language, and the tool is named in the prompt for every request, so a call is run.
  offeredWhen: ({ userText }) => /\b(remember|memorize|forget|from now on|always|never forget|note that|my preference)\b/i.test(userText),
  description: "Save a lasting fact about the person or the project (a preference, a decision, a convention), not task progress. action add (default), replace or forget a note: target is its id or some of its words.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["add", "replace", "forget"] },
      note: { type: "string", description: "the fact, in one line" },
      target: { type: "string", description: "replace/forget: id or words of the note" },
      scope: { type: "string", enum: ["project", "user"], description: "project (default) or user, for every project" },
    },
  },
  fixArgs: (a) => ({ ...a, note: a.note ?? a.text ?? a.content ?? a.fact, target: a.target ?? a.id ?? a.match, action: a.action ?? (a.target || a.id ? (a.note || a.text ? "replace" : "forget") : "add") }),
  title: (a) => `${str(a.action) === "forget" ? "Forget" : str(a.action) === "replace" ? "Replace" : "Remember"}: ${(str(a.note) || str(a.target)).slice(0, 120)}`,
  async run(a, ctx) {
    if (!ctx.memory) return "Error: memory is not available here.";
    const scope: Scope = a.scope === "user" ? "user" : "project";
    const action = str(a.action), target = str(a.target), note = str(a.note);
    const op: MemoryOp | undefined = action === "forget" ? (target ? { action, scope, target } : undefined) : action === "replace" ? (target ? { action, scope, target, text: note } : undefined) : { action: "add", scope, text: note };
    if (!op) return `Error: ${action} needs target (the note's id or some of its words). Example: {"action":"${action}","target":"tabs"${action === "replace" ? ',"note":"Use spaces"' : ""}}`;
    const web = ctx.untrusted === true;
    return keep(ctx.memory, op, { today: new Date().toISOString().slice(0, 10), origin: web ? "web" : "self", stage: web && ctx.mode === "ask" });
  },
};
