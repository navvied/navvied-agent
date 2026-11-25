import type { Tool } from "../types.ts";
import { str } from "./util.ts";

const SCOPES = ["project", "user"];

export const skillManage: Tool = {
  name: "SkillManage",
  readOnly: false,
  offeredWhen: ({ chat, userText }) => chat !== true && /\b(make|create|write|save|keep|turn|add|edit|change|update|delete|remove|patch|new)\b.{0,40}\bskills?\b/i.test(userText),
  description: "Keep what you learned about a kind of task as a skill: list, view, create (content is SKILL.md with name and description in front matter), patch (replace old with new), delete. Not for one-off notes.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["list", "view", "create", "patch", "delete"] },
      name: { type: "string" },
      content: { type: "string", description: "create: the text of the file" },
      old: { type: "string", description: "patch: the exact text to replace" },
      new: { type: "string", description: "patch: its replacement" },
      file: { type: "string", description: "a file next to SKILL.md (default SKILL.md)" },
      scope: { type: "string", enum: SCOPES, description: "create: project (default) or user" },
    },
    required: ["action"],
  },
  fixArgs: (a) => ({ ...a, action: a.action ?? a.op ?? a.operation, content: a.content ?? a.text ?? a.body, new: a.new ?? a.replacement ?? a.new_string, old: a.old ?? a.old_string }),
  title: (a) => `${str(a.action) || "Manage"} skill ${str(a.name)}`.trim(),
  async run(a, ctx) {
    const book = ctx.skillBook;
    if (!book) return "Error: skills cannot be changed here.";
    const known = ctx.skills?.() ?? [];
    const action = str(a.action), name = str(a.name).trim();
    if (!["list", "view", "create", "patch", "delete"].includes(action)) return 'Error: action is one of list, view, create, patch, delete. Example: {"action":"list"}';
    if (action === "list") return known.length ? known.map((s) => `- ${s.name} (${s.source}): ${s.description.slice(0, 100)}`).join("\n") : "There are no skills yet.";
    if (!name) return `Error: give the skill's name (name). ${book.known(known)}`;
    if (action === "view") {
      const found = known.find((s) => s.name === name);
      return found ? book.view(found, str(a.file) || undefined) : `Error: there is no skill "${name}". ${book.known(known)}`;
    }
    const stage = (ctx.skillApproval?.() ?? "auto") === "ask" || ctx.untrusted === true;
    const file = str(a.file) || undefined;
    if (action === "create") return book.edit({ action, name, scope: a.scope === "user" ? "user" : "project", text: str(a.content), ...(file ? { file } : {}) }, "agent", stage, known);
    if (action === "patch") return book.edit({ action, name, old: str(a.old), replace: str(a.new), ...(file ? { file } : {}) }, "agent", stage, known);
    return book.edit({ action: "delete", name }, "agent", stage, known);
  },
};
