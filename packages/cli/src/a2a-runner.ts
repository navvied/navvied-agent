import { createHash } from "node:crypto";
import type { AgentEngine } from "@navvied/engine";
import type { EngineEvent, PermMode, Result } from "@navvied/protocol";
import type { RunJob, RunResult, TaskRunner } from "./a2a-server.ts";

/** Makes an engine for one conversation with a peer. The engine says what it does to `emit`. */
export type MakeEngine = (emit: (e: EngineEvent) => void, session: string) => Result<AgentEngine>;

interface Slot { engine: AgentEngine; sink: Sink | undefined; /** The conversation takes one task at a time: the next waits for the end of this one, however that ended. */ last: Promise<unknown> }
interface Sink { answer: string; error?: string; progress(text: string): void }

/** The same conversation gets the same engine session after a restart: the name is made from who asked and the context, which the peer chose. */
const sessionOf = (peer: string, context: string): string => `a2a-${peer}-${createHash("sha256").update(context).digest("hex").slice(0, 16)}`;

/**
 * Runs the tasks of peers on engines of this computer, one engine per conversation. No one is there to answer a question or to allow a
 * step: a question is answered with "nobody", an approval is refused. Every turn runs in `mode` and in no other, whatever the peer wrote.
 * `quiet` is told what went wrong inside (it never reaches the peer: the words that do are fixed).
 */
export function engineRunner(make: MakeEngine, mode: PermMode, quiet: (what: string) => void = () => undefined): TaskRunner {
  const slots = new Map<string, Slot>();
  const keyOf = (peer: string, context: string): string => `${peer}\0${context}`;

  const slotFor = (peer: string, context: string): Slot | undefined => {
    const key = keyOf(peer, context);
    const had = slots.get(key);
    if (had) return had;
    const slot: Slot = { engine: undefined as never, sink: undefined, last: Promise.resolve() };
    const made = make((e) => {
      const sink = slot.sink;
      if (e.ev === "approval") slot.engine.handle({ cmd: "approve", id: e.id, optionId: "deny", unasked: true });
      else if (e.ev === "question") slot.engine.handle({ cmd: "answer", id: e.id, answers: e.questions.map(() => []) });
      if (!sink) return;
      if (e.ev === "text") { sink.answer += e.text; sink.progress(e.text); }
      else if (e.ev === "tool" && e.status === "running") sink.answer = "";
      else if (e.ev === "error" && !sink.error) sink.error = e.msg;
    }, sessionOf(peer, context));
    if (!made.ok) { quiet(made.error); return undefined; }
    slot.engine = made.value;
    slots.set(key, slot);
    return slot;
  };

  return {
    async run(job: RunJob): Promise<RunResult> {
      const slot = slotFor(job.peer, job.context);
      if (!slot) return { state: "failed", text: "This agent is not set up to answer." };
      const turn = slot.last.then(async (): Promise<RunResult> => {
        if (job.signal.aborted) return { state: "failed", text: "" };
        const sink: Sink = { answer: "", progress: job.progress };
        slot.sink = sink;
        const cancel = (): void => slot.engine.handle({ cmd: "cancel" });
        job.signal.addEventListener("abort", cancel, { once: true });
        try {
          slot.engine.handle({ cmd: "prompt", text: job.text, from: job.from, qid: crypto.randomUUID(), mode });
          await slot.engine.idle();
        } finally { job.signal.removeEventListener("abort", cancel); slot.sink = undefined; }
        if (sink.error) { quiet(sink.error); return { state: "failed", text: "The agent could not answer." }; }
        return { state: "completed", text: sink.answer.trim() };
      });
      slot.last = turn.catch(() => undefined);
      return turn;
    },
    drop(peer, context) {
      const key = keyOf(peer, context);
      slots.get(key)?.engine.close();
      slots.delete(key);
    },
    close() {
      for (const s of slots.values()) s.engine.close();
      slots.clear();
    },
  };
}
