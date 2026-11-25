import type { QuestionItem } from "@navvied/protocol";
import type { Tool } from "../types.ts";
import { str } from "./util.ts";

export const ASK_TOOL_NAME = "AskUserQuestion";
const MOST_QUESTIONS = 4;
const MOST_CHOICES = 4;

/** What a model sent as questions, made into the shape of the protocol: a lone question may come as text, choices as a list of words. */
export function questionsOf(raw: unknown): QuestionItem[] {
  const list = Array.isArray(raw) ? raw : typeof raw === "string" && raw.trim() ? [raw] : [];
  return list.slice(0, MOST_QUESTIONS).flatMap((q): QuestionItem[] => {
    const o: Record<string, unknown> = typeof q === "object" && q !== null ? (q as Record<string, unknown>) : { question: q };
    const question = str(o.question).trim();
    if (!question) return [];
    const choices = (Array.isArray(o.choices) ? o.choices : Array.isArray(o.options) ? o.options : [])
      .map((c) => (typeof c === "object" && c !== null ? str((c as Record<string, unknown>).label) : str(c)).trim())
      .filter(Boolean).slice(0, MOST_CHOICES);
    return [{ question, ...(choices.length ? { choices } : {}), ...(o.multi === true || o.multiSelect === true ? { multi: true as const } : {}) }];
  });
}

/** Ask the person something only they know. Read-only, so plan mode may use it; the engine runs it (it waits for a person), not the tool. */
export const ask: Tool = {
  name: ASK_TOOL_NAME,
  readOnly: true,
  description: "Ask the person 1-4 questions only when you cannot go on without the answer. Up to 4 short choices each, your recommendation first; they may answer in their own words. Decide small things yourself.",
  parameters: {
    type: "object",
    properties: {
      questions: {
        type: "array",
        items: { type: "object", properties: { question: { type: "string" }, choices: { type: "array", items: { type: "string" } }, multi: { type: "boolean" } }, required: ["question"] },
      },
    },
    required: ["questions"],
  },
  fixArgs: (a) => ({ ...a, questions: a.questions ?? a.question }),
  title: (a) => `Ask: ${questionsOf(a.questions)[0]?.question.slice(0, 80) ?? "a question"}`,
  async run(a, ctx) {
    const questions = questionsOf(a.questions);
    if (!questions.length) return `Error: ${ASK_TOOL_NAME} needs questions: {"questions": [{"question": "Which database?", "choices": ["Postgres", "SQLite"]}]}`;
    if (!ctx.ask) return "Error: nobody can be asked here.";
    return ctx.ask(questions, ctx.signal);
  },
};
