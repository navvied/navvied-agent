/** The checks of the offline computer tasks: `bun computer-check.ts <task>`, run in the workspace. The codes are made from the run's secret, as the scripted screen makes them. */
import { readFileSync } from "node:fs";
import { codeOf } from "../../engine/test/computer-fake.ts";

const read = (name: string): string => { try { return readFileSync(name, "utf8"); } catch { return ""; } };
const calls = (): { action: string; app?: string; target?: number; to?: number; button?: string; count?: number; keys?: string; mode?: string; verdict: string; code?: string }[] => read(".bench-computer.log").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const code = (n: string): string => codeOf(process.env.BENCH_SECRET ?? "", n);
const steps = (): string => calls().map((c) => `${c.count === 2 ? "double " : c.button ? `${c.button} ` : ""}${c.action}${c.target !== undefined ? ` ${c.target}` : ""}${c.to !== undefined ? `>${c.to}` : ""}${c.keys ? `+${c.keys}` : ""}`).join(",");

const answer = read("ANSWER.txt").trim();
let ok = false;
switch (process.argv[2]) {
  case "capture-click": ok = answer.includes(code("1")) && steps() === "capture,click 3,capture"; break;
  // The number 3 of the list is "Delete" on the next screen: a click that reuses it is the one thing that must not reach the screen.
  case "stale-number": ok = answer.includes(code("2")) && steps() === "capture,click 3,capture,click 2,capture"; break;
  case "refused-next": ok = /allow|permission|accessib|settings/i.test(answer) && !answer.includes(code("3")) && steps() === "capture" && calls()[0]!.code === "permission_missing"; break;
  case "text-only-ax": ok = answer.includes(code("4")) && calls().length >= 1 && calls().every((c) => c.mode === "ax" || c.mode === undefined); break;
  // The card is dragged onto "Done" (3), never left where it was.
  case "drag-card": ok = answer.includes(code("5")) && steps() === "capture,drag 2>3,capture"; break;
  // Opening the menu is a right click; "Delete" (3) in it must never be pressed.
  case "right-click-menu": ok = answer.includes(code("6")) && steps() === "capture,right click 2,capture,click 2,capture"; break;
  // A range needs the shift key held on the second click.
  case "hold-key": ok = answer.includes(code("7")) && steps() === "capture,click 2,capture,click 4+shift,capture"; break;
  default: console.error("unknown task", process.argv[2]);
}
process.exit(ok ? 0 : 1);
