import type { EngineEvent, SetupStep, ToolEntry } from "@navvied/protocol";
import type { Kit } from "./providers/kit.ts";

type Setup = Extract<EngineEvent, { ev: "tool.setup" }>;

const MARK = { done: "✓", failed: "✗", active: "…", waiting: "•" } as const;

function follow(k: Kit, id: string) {
  let last: Setup | undefined;
  const waiting: ((e: Setup) => void)[] = [];
  const stop = k.link.watch((e) => {
    if (e.ev !== "tool.setup" || e.id !== id) return;
    last = e;
    for (const w of waiting.splice(0)) w(e);
  });
  return { last: (): Setup | undefined => last, next: (): Promise<Setup> => new Promise((resolve) => { waiting.push(resolve); }), stop };
}

function stepRows(steps: SetupStep[], percent: number | undefined, dim: (text: string) => string): { label: string }[] {
  return steps.map((s) => ({ label: `${s.state === "waiting" ? dim(MARK.waiting) : MARK[s.state]}  ${s.name}${s.state === "active" ? `  ${s.total > 0 ? Math.round((s.bytes / s.total) * 100) : (percent ?? 0)}%` : ""}` }));
}

export async function toolSetup(k: Kit, e: Pick<ToolEntry, "id" | "title" | "about">): Promise<void> {
  const run = follow(k, e.id);
  try {
    k.link.send({ cmd: "tool.setup", id: e.id });
    let state = await run.next();
    for (;;) {
      if (state.state === "unavailable") { k.note.push(state.error ?? "This cannot be set up here."); return; }
      if (state.state === "done") { k.note.push(`${e.title} is ready.`); return; }
      if (state.state === "idle") return;
      if (state.state === "ask" || state.state === "failed") {
        const failed = state.state === "failed";
        const steps = state.steps ?? [];
        const body = failed
          ? [...stepRows(steps, state.percent, k.dim).map((r) => r.label), "", `✗ ${state.error ?? "The setup stopped."}`]
          : [e.about, "", ...steps.map((s, i) => `  ${i + 1}  ${s.name}`)];
        const picked = await k.choose(failed ? e.title : "Needs setup", e.title, failed ? [{ label: "Try again" }, { label: "Not now" }] : [{ label: "Start setup" }, { label: "Not now" }], { body });
        if (picked !== 0) { if (!failed) k.link.send({ cmd: "tool.setup.cancel", id: e.id }); return; }
        const answered = run.next();
        k.link.send(failed ? { cmd: "tool.setup", id: e.id } : { cmd: "tool.setup.approve", id: e.id });
        state = await answered;
        continue;
      }
      const ended = (): boolean => ["done", "failed", "unavailable", "idle"].includes(run.last()!.state);
      const picked = await k.choose(e.title, e.title, [{ label: "Cancel" }], {
        body: stepRows(state.steps ?? [], state.percent, k.dim).map((r) => r.label),
        live: () => { const now = run.last()!; return { rows: [{ label: "Cancel" }], body: stepRows(now.steps ?? [], now.percent, k.dim).map((r) => r.label), ...(ended() ? { auto: 0 } : {}) }; },
      });
      state = run.last()!;
      if (!ended() && picked === undefined || picked === 0 && !ended()) { k.link.send({ cmd: "tool.setup.cancel", id: e.id }); return; }
    }
  } finally { run.stop(); }
}
