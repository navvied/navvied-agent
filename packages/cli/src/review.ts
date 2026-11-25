import { SkillBook, pendingNotes, resolvePending, type MemoryPaths, type SkillInfo } from "@navvied/engine";
import type { EngineEvent } from "@navvied/protocol";
import type { SkillTrust } from "./plugins.ts";

/** What waits for the person among the agent's notes and skills, and how each is answered (`memory.pending`, `skill.review`, `skill.rollback`). */
export interface Review {
  memory: MemoryPaths;
  book: SkillBook;
  trust: SkillTrust;
  /** Every skill in reach, accepted or not. */
  skills: () => SkillInfo[];
}

type Event<T extends EngineEvent["ev"]> = Extract<EngineEvent, { ev: T }>;
const notice = (msg: string): EngineEvent => (msg.startsWith("Error:") ? { ev: "error", msg: msg.replace(/^Error:\s*/, "") } : { ev: "notice", msg });

export const memoryPending = (r: Review): Event<"memory.pending"> => ({ ev: "memory.pending", items: pendingNotes(r.memory).map(({ id, scope, action, text, target, origin, at }) => ({ id, scope, action, text, ...(target ? { target } : {}), origin, at })) });

export function answerMemory(r: Review, action: "accept" | "reject", id: string, today: string): EngineEvent[] {
  return [notice(resolvePending(r.memory, id, action === "accept", today)), memoryPending(r)];
}

const state = (c: { applied: boolean; outcome?: string }): "applied" | "waiting" | "rejected" | "undone" => (c.outcome === "rejected" ? "rejected" : c.outcome === "rolled-back" ? "undone" : c.applied ? "applied" : "waiting");

export function skillReview(r: Review): Event<"skill.review"> {
  const changes = r.book.changes();
  const waiting = r.book.staged().map((c) => ({ id: c.id, kind: "change" as const, name: c.name, summary: `${c.action} ${c.name}` }));
  const trust = r.trust.waiting(r.skills()).map((s) => ({ id: `trust:${s.name}`, kind: "trust" as const, name: s.name, summary: s.description, ...(s.findings.length ? { findings: s.findings } : {}) }));
  return { ev: "skill.review", items: [...waiting, ...trust], history: changes.slice(-30).map((c) => ({ id: c.id, name: c.name, action: c.action, actor: c.actor, at: c.at, state: state(c) })) };
}

export function answerSkill(r: Review, id: string, accept: boolean): EngineEvent[] {
  if (id.startsWith("trust:")) {
    const skill = r.skills().find((s) => s.name === id.slice(6));
    if (!skill) return [{ ev: "error", msg: "That skill is not here any more." }, skillReview(r)];
    r.trust.answer(skill, accept);
    return [skillReview(r)];
  }
  return [notice(r.book.resolve(id, accept)), skillReview(r)];
}

export const rollbackSkill = (r: Review, id?: string): EngineEvent[] => [notice(r.book.rollback(id)), skillReview(r)];

