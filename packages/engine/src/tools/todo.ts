import type { PlanEntry } from "@navvied/protocol";
import type { Tool } from "../types.ts";
import { str } from "./util.ts";

export const TODO_TOOL_NAME = "TodoWrite";
const MOST_ITEMS = 30;
const MOST_TEXT = 300;

/** The words models use for a state, and the state they mean. */
const STATE: Record<string, PlanEntry["status"]> = {
  completed: "completed", complete: "completed", done: "completed", finished: "completed", checked: "completed",
  in_progress: "in_progress", inprogress: "in_progress", active: "in_progress", doing: "in_progress", started: "in_progress", current: "in_progress",
};
const statusOf = (v: unknown): PlanEntry["status"] => STATE[str(v).toLowerCase().replace(/[\s-]+/g, "_")] ?? "pending";

/** The list as the model sent it, or what is wrong with it. One item at a time may be in progress: more than one is sent back to be fixed, and the list is not kept. */
export function parseTodos(raw: unknown): { entries: PlanEntry[] } | { problem: string } {
  const items = Array.isArray(raw) ? raw : [];
  const entries = items.slice(0, MOST_ITEMS).flatMap((t): PlanEntry[] => {
    const o: Record<string, unknown> = typeof t === "object" && t !== null ? (t as Record<string, unknown>) : { content: t };
    const title = str(o.content || o.title || o.task || o.text).trim().slice(0, MOST_TEXT);
    const activeForm = str(o.activeForm || o.active_form).trim().slice(0, MOST_TEXT);
    return title ? [{ title, status: statusOf(o.status), ...(activeForm ? { activeForm } : {}) }] : [];
  });
  if (!entries.length) return { problem: 'Error: TodoWrite needs the whole list: {"todos": [{"content": "Run the tests", "status": "in_progress", "activeForm": "Running the tests"}]}' };
  const going = entries.filter((e) => e.status === "in_progress");
  if (going.length > 1) return { problem: `Error: ${going.length} items are in_progress (${going.map((e) => e.title).join("; ")}). Only one at a time: send the whole list again with one in_progress, the finished ones completed and the rest pending.` };
  return { entries };
}

const MARK: Record<string, string> = { completed: "[x]", in_progress: "[>]", pending: "[ ]" };

/** The list in few characters, one line an item. */
export const listText = (entries: readonly PlanEntry[]): string => entries.map((e) => `${MARK[e.status] ?? "[ ]"} ${e.status === "in_progress" && e.activeForm ? e.activeForm : e.title}`).join("\n");

/** What is not finished yet, to put back in front of the model after the conversation was summarised. */
export function unfinished(entries: readonly PlanEntry[]): string {
  const open = entries.filter((e) => e.status !== "completed");
  return open.length ? `[Your task list, kept across the summary]\n${listText(open)}` : "";
}

export const STALE_AFTER_STEPS = 6;
export const staleNote = (steps: number): string => `[Reminder: your task list has not been updated for ${steps} steps. If an item is done, mark it completed with TodoWrite; start the next one as in_progress.]`;

/** The least items a list in one sentence has to count as several parts, and the least length of an item in bytes, so a character of Chinese counts for more than one of English (so "in app.py, line 3, change it" is not a list). */
const SEVERAL = 3, ITEM = 12;
/** Whether one sentence of the request lists several things to do, split by commas or semicolons (so it reads the same in any language). Separate sentences are not counted: they are often one task and its limits. */
export const hasSeveralParts = (text: string): boolean =>
  text.split(/\n|[。！？]|[.!?]+(?:\s|$)/).some((sentence) => sentence.split(/[;；,，、]/).filter((p) => Buffer.byteLength(p.trim()) >= ITEM).length >= SEVERAL);

export const todo: Tool = {
  name: TODO_TOOL_NAME,
  readOnly: true,
  /** Work that is long or listed: from the first step when the request has several parts or is long or a list, else after a few steps of it. Not for small models. */
  offeredWhen: ({ small, userText, steps }) => !small && ((steps ?? 0) >= 4 || userText.length > 400 || /(^|\n)\s*(\d+[.)]|[-*])\s/.test(userText) || hasSeveralParts(userText)),
  description: "Keep a task list for work in several steps. Send the whole list each time. Exactly one item in_progress; mark it completed as soon as it is done.",
  parameters: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        items: {
          type: "object",
          properties: { content: { type: "string" }, status: { type: "string", enum: ["pending", "in_progress", "completed"] }, activeForm: { type: "string", description: "present tense, shown while it runs" } },
          required: ["content", "status"],
        },
      },
    },
    required: ["todos"],
  },
  fixArgs: (a) => ({ ...a, todos: a.todos ?? a.items ?? a.tasks ?? a.list }),
  title: () => "Update task list",
  async run(a, ctx) {
    const parsed = parseTodos(a.todos);
    if ("problem" in parsed) return parsed.problem;
    const { entries } = parsed;
    ctx.emit({ ev: "plan", entries, raw: JSON.stringify(entries).slice(0, 2000) });
    const open = entries.some((e) => e.status !== "completed");
    const note = !open ? "\nAll done." : entries.some((e) => e.status === "in_progress") ? "" : "\nNo item is in_progress: mark the one you start next.";
    return `Task list updated:\n${listText(entries)}${note}`;
  },
};
