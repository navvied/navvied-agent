import type { QuestionItem } from "@navvied/protocol";

/** Most questions one turn may ask: a page that makes the model ask again and again gets no more after this. */
export const MOST_QUESTIONS_PER_TURN = 3;
/** How long a window is waited for when one is attached (seconds), unless the program says otherwise. */
export const DEFAULT_ASK_WAIT_S = 600;

/** What the model is told when nobody can answer: it must go on, and say what it assumed. */
export const NOBODY_ANSWERS = "Nobody can answer now: pick the most reasonable option, say what you assumed, and do the work.";

/** The questions of one call that wait for the person, by id. */
export class QuestionBroker {
  #waiting = new Map<string, (answers: string[][] | undefined) => void>();
  #next = 0;

  open(): { id: string; answer: Promise<string[][] | undefined> } {
    const id = `q${++this.#next}`;
    return { id, answer: new Promise((resolve) => this.#waiting.set(id, resolve)) };
  }

  /** The person's answers. False for an id that is not waiting (a late or repeated answer). */
  answer(id: string, answers: string[][]): boolean { return this.#settle(id, answers); }

  /** Gives up on one question: the person did not answer in time, or the turn was stopped. */
  close(id: string): void { this.#settle(id, undefined); }

  closeAll(): void { for (const id of [...this.#waiting.keys()]) this.close(id); }

  #settle(id: string, answers: string[][] | undefined): boolean {
    const resolve = this.#waiting.get(id);
    if (!resolve) return false;
    this.#waiting.delete(id);
    resolve(answers);
    return true;
  }
}

/** One line per question, `Q -> "answer"`: the way the model reads what the person chose. */
export function answersText(questions: readonly QuestionItem[], answers: readonly string[][]): string {
  return questions.map((q, i) => { const a = (answers[i] ?? []).map((x) => x.trim()).filter(Boolean); return `${q.question} -> ${a.length ? `"${a.join(", ")}"` : "(no answer)"}`; }).join("\n");
}
