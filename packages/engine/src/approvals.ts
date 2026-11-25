import type { ApprovalOption } from "@navvied/protocol";

export const ALLOW = "allow";
export const DENY = "deny";
export const ALLOW_ALWAYS = "allow_always";
export const EDIT = "edit";

/** The choices on a question: yes once, yes and stop asking about this kind of thing, or no. */
export const approvalOptions = (phrase: string, editable?: string): ApprovalOption[] => [
  { optionId: ALLOW, name: "Allow", kind: "allow_once" },
  { optionId: ALLOW_ALWAYS, name: `Allow, and do not ask again for ${phrase}`, kind: "allow_always" },
  ...(editable !== undefined ? [{ optionId: EDIT, name: "Edit", kind: "allow_once", editable: { value: editable } } as ApprovalOption] : []),
  { optionId: DENY, name: "Deny", kind: "reject_once" },
];

/** What came back for a question: the choice, what the person typed, and whether nobody was asked at all. */
export interface ApprovalAnswer { optionId: string; input?: string; unasked?: boolean }

export class ApprovalBroker {
  #waiting = new Map<string, (answer: ApprovalAnswer) => void>();
  #next = 0;

  open(): { id: string; answer: Promise<ApprovalAnswer> } {
    const id = `ask${++this.#next}`;
    const answer = new Promise<ApprovalAnswer>((resolve) => this.#waiting.set(id, resolve));
    return { id, answer };
  }

  /** The user's choice. Unknown ids are ignored (a late or duplicate answer). */
  answer(id: string, optionId: string, input?: string, unasked?: boolean): boolean {
    const resolve = this.#waiting.get(id);
    if (!resolve) return false;
    this.#waiting.delete(id);
    resolve({ optionId, ...(input !== undefined ? { input } : {}), ...(unasked ? { unasked } : {}) });
    return true;
  }

  denyAll(): void { for (const id of [...this.#waiting.keys()]) this.answer(id, DENY); }

  get pending(): number { return this.#waiting.size; }
}
