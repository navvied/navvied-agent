import type { EngineEvent } from "@navvied/protocol";
import type { IO } from "./io.ts";
import { paint } from "./render.ts";

type Asked = Extract<EngineEvent, { ev: "question" }>;

/**
 * Asks the person the agent's questions with the arrow keys, one list a question; the choices are the agent's, and the person's own
 * words come from the last row. A question with several answers is a list that is picked from until the person is done. Escape skips
 * the question (and with it the rest). One list of answers per question, as the `answer` command takes them.
 */
export async function askQuestions(io: IO, e: Asked): Promise<string[][]> {
  const answers: string[][] = [];
  if (!io.choose) return e.questions.map(() => []);
  for (const q of e.questions) {
    const heading = [paint(io.color, "cyan", paint(io.color, "bold", q.question))];
    const picked: string[] = [];
    for (;;) {
      const left = (q.choices ?? []).filter((c) => !picked.includes(c));
      const rows = [...left.map((label) => ({ label })), ...(io.text ? [{ label: "Something else" }] : []), ...(q.multi && picked.length ? [{ label: "Done" }] : [])];
      if (!rows.length) break;
      const answer = await io.choose(q.multi ? "Pick any" : "Pick one", rows, 0, { heading });
      const row = typeof answer === "number" ? rows[answer] : undefined;
      if (!row) { if (!q.multi || !picked.length) { answers.push(picked); return [...answers, ...e.questions.slice(answers.length).map(() => [])]; } break; }
      if (row.label === "Done") break;
      if (row.label === "Something else" && io.text) {
        const said = await io.text("Your answer", "", { heading });
        if (typeof said === "string" && said.trim()) picked.push(said.trim());
        else continue;
      } else picked.push(row.label);
      if (!q.multi) break;
    }
    answers.push(picked);
  }
  return answers;
}
