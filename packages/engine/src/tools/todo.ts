import type { PlanEntry } from "@navvied/protocol";
import type { Tool } from "../types.ts";
import { str } from "./util.ts";

const STATUSES = new Set(["pending", "in_progress", "completed"]);

export const todo: Tool = {
  name: "TodoWrite",
  readOnly: true,
  /** Work that is long or listed: after a few steps of it, or when the request is a list or long. */
  offeredWhen: ({ small, userText, steps }) => !small && ((steps ?? 0) >= 4 || userText.length > 400 || /(^|\n)\s*(\d+[.)]|[-*])\s/.test(userText)),
  description: "Keep a task list for work in several steps: send the whole list each time, one item in_progress at most.",
  parameters: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        items: {
          type: "object",
          properties: { content: { type: "string" }, status: { type: "string", enum: ["pending", "in_progress", "completed"] } },
          required: ["content", "status"],
        },
      },
    },
    required: ["todos"],
  },
  title: () => "Update task list",
  async run(a, ctx) {
    const items = Array.isArray(a.todos) ? a.todos : [];
    const entries: PlanEntry[] = items
      .filter((t): t is Record<string, unknown> => typeof t === "object" && t !== null)
      .map((t) => ({ title: str(t.content), status: STATUSES.has(str(t.status)) ? str(t.status) : "pending" }))
      .filter((e) => e.title);
    ctx.emit({ ev: "plan", entries, raw: JSON.stringify(entries).slice(0, 2000) });
    return `Task list updated (${entries.length} item${entries.length === 1 ? "" : "s"}).`;
  },
};
