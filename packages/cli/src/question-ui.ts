import type { EngineEvent } from "@navvied/protocol";
import type { IO } from "./io.ts";
import { paint } from "./render.ts";

type Asked = Extract<EngineEvent, { ev: "question" }>;

export const QUESTION_TITLE = "A question";
const OWN_WORDS = "In my own words…";
const DONE = "Done";
export const ANSWERED = "Answered. navvied is continuing.";

/** What the conversation keeps of the questions: each one with the answers given (a question that was skipped is left out), then that the agent goes on. Nothing when nothing was answered. */
export function answeredLines(color: boolean, e: Asked, answers: string[][]): string[] {
  const given = e.questions.flatMap((q, i) => (answers[i]?.length ? [{ q, said: answers[i]! }] : []));
  if (!given.length) return [];
  return [...given.flatMap(({ q, said }) => [q.question, ...said.map((a) => `${paint(color, "cyan", "●")} ${a}`)]), "", paint(color, "dim", ANSWERED)];
}

/**
 * Asks the person the agent's questions with the arrow keys, one list a question; the choices are the agent's, and the person's own
 * words come from the last row. A question with several answers is a list that is picked from until the person is done. Escape skips
 * the question (and with it the rest). One list of answers per question, as the `answer` command takes them.
 */
export async function askQuestions(io: IO, e: Asked): Promise<string[][]> {
  const answers: string[][] = [];
  if (!io.choose) return e.questions.map(() => []);
  for (const q of e.questions) {
    const frame = { body: ["", q.question] };
    const picked: string[] = [];
    for (;;) {
      const left = (q.choices ?? []).filter((c) => !picked.includes(c));
      const rows = [...left.map((label) => ({ label })), ...(io.text ? [{ label: OWN_WORDS }] : []), ...(q.multi && picked.length ? [{ label: DONE }] : [])];
      if (!rows.length) break;
      const answer = await io.choose(QUESTION_TITLE, rows, 0, frame);
      const row = typeof answer === "number" ? rows[answer] : undefined;
      if (!row) { if (!q.multi || !picked.length) { answers.push(picked); return [...answers, ...e.questions.slice(answers.length).map(() => [])]; } break; }
      if (row.label === DONE) break;
      if (row.label === OWN_WORDS && io.text) {
        const said = await io.text(QUESTION_TITLE, "", frame);
        if (typeof said === "string" && said.trim()) picked.push(said.trim());
        else continue;
      } else picked.push(row.label);
      if (!q.multi) break;
    }
    answers.push(picked);
  }
  return answers;
}
