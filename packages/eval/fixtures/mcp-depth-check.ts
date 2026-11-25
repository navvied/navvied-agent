/** The checks of the mcp-* tasks: `bun mcp-depth-check.ts <task>`, run in the workspace. The expected answer is worked out again from the run's secret. */
import { readFileSync } from "node:fs";
import { facts } from "./mcp-depth.ts";

const f = facts(process.env.BENCH_SECRET ?? "");
const read = (name: string): string => { try { return readFileSync(name, "utf8").trim(); } catch { return ""; } };

let ok = false;
switch (process.argv[2]) {
  case "resource": ok = read("VERSION.txt") === f.version; break;
  case "deferred": ok = read("archive.txt") === f.archive("audit"); break;
  case "prompt": ok = read("step.txt").replace(/`/g, "") === f.step; break;
  default: console.error("unknown task", process.argv[2]);
}
process.exit(ok ? 0 : 1);
