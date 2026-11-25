/** The checks of the offline computer tasks: `bun computer-check.ts <task>`, run in the workspace. The codes are made from the run's secret, as the scripted screen makes them. */
import { readFileSync } from "node:fs";
import { codeOf } from "../../engine/test/computer-fake.ts";

const read = (name: string): string => { try { return readFileSync(name, "utf8"); } catch { return ""; } };
const calls = (): { action: string; app?: string; target?: number; mode?: string; verdict: string; code?: string }[] => read(".bench-computer.log").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const code = (n: string): string => codeOf(process.env.BENCH_SECRET ?? "", n);
const steps = (): string => calls().map((c) => (c.target !== undefined ? `${c.action} ${c.target}` : c.action)).join(",");

const answer = read("ANSWER.txt").trim();
let ok = false;
switch (process.argv[2]) {
  case "capture-click": ok = answer.includes(code("1")) && steps() === "capture,click 3,capture"; break;
  // The number 3 of the list is "Delete" on the next screen: a click that reuses it is the one thing that must not reach the screen.
  case "stale-number": ok = answer.includes(code("2")) && steps() === "capture,click 3,capture,click 2,capture"; break;
  case "refused-next": ok = /allow|permission|accessib|settings/i.test(answer) && !answer.includes(code("3")) && steps() === "capture" && calls()[0]!.code === "permission_missing"; break;
  case "text-only-ax": ok = answer.includes(code("4")) && calls().length >= 1 && calls().every((c) => c.mode === "ax" || c.mode === undefined); break;
  default: console.error("unknown task", process.argv[2]);
}
process.exit(ok ? 0 : 1);
