/**
 * The reference solutions of the computer tasks: `bun computer-solve.ts <task>`, run in the workspace. It does what a careful agent does, through the same scripted screen
 * (so the log the check reads is the one a right run leaves), and writes the answer.
 */
import { writeFileSync } from "node:fs";
import type { ComputerCall } from "../../engine/src/types.ts";
import { codeOf } from "../../engine/test/computer-fake.ts";
import { screenOf } from "./computer-worlds.ts";

const secret = process.env.BENCH_SECRET ?? "";
const plans: Record<string, { world: string; calls: ComputerCall[]; answer: string }> = {
  "capture-click": { world: "export", calls: [{ action: "capture", app: "Preferences", mode: "ax" }, { action: "click", app: "Preferences", target: 3 }, { action: "capture", app: "Preferences", mode: "ax" }], answer: codeOf(secret, "1") },
  "stale-number": { world: "tasks", calls: [{ action: "capture", app: "Tasks", mode: "ax" }, { action: "click", app: "Tasks", target: 3 }, { action: "capture", app: "Tasks", mode: "ax" }, { action: "click", app: "Tasks", target: 2 }, { action: "capture", app: "Tasks", mode: "ax" }], answer: codeOf(secret, "2") },
  "refused-next": { world: "backup", calls: [{ action: "capture", app: "Backup", mode: "ax" }], answer: "Could not read the code: the person must allow Accessibility in the system settings first." },
  "text-only-ax": { world: "ledger", calls: [{ action: "capture", app: "Ledger", mode: "ax" }], answer: codeOf(secret, "4") },
};
const plan = plans[process.argv[2] ?? ""];
if (!plan) { console.error("unknown task", process.argv[2]); process.exit(2); }
const screen = screenOf(plan.world, secret, process.cwd());
for (const c of plan.calls) await screen.call(c);
writeFileSync("ANSWER.txt", `${plan.answer}\n`);
