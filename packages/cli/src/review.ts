import { SkillBook, pendingEvent, resolvePending, type MemoryPaths, type Pack, type SkillInfo } from "@navvied/engine";
import type { EngineEvent } from "@navvied/protocol";
import { packTrustKey, packsWaiting, type SkillTrust } from "./plugins.ts";

/** What waits for the person among the agent's notes and skills, and how each is answered (`memory.pending`, `skill.review`, `skill.rollback`). */
export interface Review {
  memory: MemoryPaths;
  book: SkillBook;
  trust: SkillTrust;
  /** Every skill in reach, accepted or not. */
  skills: () => SkillInfo[];
  /** Every plugin in reach, accepted or not. */
  packs?: () => Pack[];
}

type Event<T extends EngineEvent["ev"]> = Extract<EngineEvent, { ev: T }>;
export const notice = (msg: string): EngineEvent => (msg.startsWith("Error:") ? { ev: "error", msg: msg.replace(/^Error:\s*/, "") } : { ev: "notice", msg });

export const memoryPending = (r: Review): Event<"memory.pending"> => pendingEvent(r.memory);

export function answerMemory(r: Review, action: "accept" | "reject", id: string, today: string): EngineEvent[] {
  return [notice(resolvePending(r.memory, id, action === "accept", today)), memoryPending(r)];
}

const state = (c: { applied: boolean; outcome?: string }): "applied" | "waiting" | "rejected" | "undone" => (c.outcome === "rejected" ? "rejected" : c.outcome === "rolled-back" ? "undone" : c.applied ? "applied" : "waiting");

export function skillReview(r: Review): Event<"skill.review"> {
  const changes = r.book.changes();
  const waiting = r.book.staged().map((c) => ({ id: c.id, kind: "change" as const, name: c.name, summary: `${c.action} ${c.name}` }));
  const trust = r.trust.waiting(r.skills()).map((s) => ({ id: `trust:${s.name}`, kind: "trust" as const, name: s.name, summary: s.description, ...(s.findings.length ? { findings: s.findings } : {}) }));
  const plugins = packsWaiting(r.packs?.() ?? [], r.trust).map((p) => ({ id: `trust:plugin:${p.name}`, kind: "trust" as const, name: p.name, summary: p.description, findings: [...(p.runs.length ? p.runs.flatMap((x) => [`${x.what}: ${x.command} (${x.source})`, ...(x.findings ?? []).map((f) => `  ${f}`)]) : ["It runs no commands."]), ...p.findings] }));
  return { ev: "skill.review", items: [...waiting, ...trust, ...plugins], history: changes.slice(-30).map((c) => ({ id: c.id, name: c.name, action: c.action, actor: c.actor, at: c.at, state: state(c) })) };
}

export function answerSkill(r: Review, id: string, accept: boolean): EngineEvent[] {
  if (id.startsWith("trust:plugin:")) {
    const pack = r.packs?.().find((p) => p.name === id.slice(13) && p.source === "project" && !p.problem);
    if (!pack) return [{ ev: "error", msg: "That plugin is not here any more." }, skillReview(r)];
    r.trust.answer(packTrustKey(pack), accept);
    return [skillReview(r)];
  }
  if (id.startsWith("trust:")) {
    const skill = r.skills().find((s) => s.name === id.slice(6));
    if (!skill) return [{ ev: "error", msg: "That skill is not here any more." }, skillReview(r)];
    r.trust.answer(skill, accept);
    return [skillReview(r)];
  }
  return [notice(r.book.resolve(id, accept)), skillReview(r)];
}

export const rollbackSkill = (r: Review, id?: string): EngineEvent[] => [notice(r.book.rollback(id)), skillReview(r)];

