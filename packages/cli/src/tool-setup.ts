import type { EngineEvent, SetupStep, ToolEntry } from "@navvied/protocol";
import type { Kit } from "./providers/kit.ts";

type Setup = Extract<EngineEvent, { ev: "tool.setup" }>;

const MARK = { done: "✓", failed: "✗", active: "…", waiting: "·" } as const;

/** What the setup of one tool has said so far, and a way to wait for the next thing it says. */
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

/** The steps as rows of a list: done, being worked on (with how far), not started, or the one that failed. */
function stepRows(steps: SetupStep[], percent: number | undefined): { label: string }[] {
  return steps.map((s) => ({ label: `${MARK[s.state]}  ${s.name}${s.state === "active" ? `  ${s.total > 0 ? Math.round((s.bytes / s.total) * 100) : (percent ?? 0)}%` : ""}` }));
}

/** The setup of a tool that waits for one (`Needs setup`): what it will do, a press to start, the steps as they go, and a way to try again. Resolves when it is done, stopped or left. */
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
          ? [...stepRows(steps, state.percent).map((r) => r.label), "", `✗ ${state.error ?? "The setup stopped."}`]
          : [e.about, "", ...steps.map((s, i) => `  ${i + 1}  ${s.name}`)];
        const picked = await k.choose(failed ? e.title : "Needs setup", e.title, failed ? [{ label: "Try again" }, { label: "Not now" }] : [{ label: "Start setup" }, { label: "Not now" }], { body });
        if (picked !== 0) { if (!failed) k.link.send({ cmd: "tool.setup.cancel", id: e.id }); return; }
        const answered = run.next();
        k.link.send(failed ? { cmd: "tool.setup", id: e.id } : { cmd: "tool.setup.approve", id: e.id });
        state = await answered;
        continue;
      }
      // Downloading, verifying or installing: the steps move until it is done or fails; Esc, or Cancel, stops it and keeps what was fetched.
      const ended = (): boolean => ["done", "failed", "unavailable", "idle"].includes(run.last()!.state);
      const picked = await k.choose(e.title, e.title, [{ label: "Cancel" }], {
        body: stepRows(state.steps ?? [], state.percent).map((r) => r.label),
        live: () => { const now = run.last()!; return { rows: [{ label: "Cancel" }], body: stepRows(now.steps ?? [], now.percent).map((r) => r.label), ...(ended() ? { auto: 0 } : {}) }; },
      });
      state = run.last()!;
      if (!ended() && picked === undefined || picked === 0 && !ended()) { k.link.send({ cmd: "tool.setup.cancel", id: e.id }); return; }
    }
  } finally { run.stop(); }
}
