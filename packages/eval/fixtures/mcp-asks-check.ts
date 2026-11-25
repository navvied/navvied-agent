/** The checks of the mcp-sample-* and mcp-elicit-* tasks: `bun mcp-asks-check.ts <task>`, run in the workspace. The expected answer is worked out again from the run's secret. */
import { readFileSync } from "node:fs";
import { facts } from "./mcp-asks.ts";

const f = facts(process.env.BENCH_SECRET ?? "");
const read = (name: string): string => { try { return readFileSync(name, "utf8").trim(); } catch { return ""; } };

let ok = false;
switch (process.argv[2]) {
  case "sample-code": ok = read("label.txt") === f.code; break;
  case "sample-unattended": ok = read("label.txt") === "unavailable"; break;
  case "elicit-unattended": ok = read("deploy.txt") === "stopped" && !read("deploy.txt").includes(f.deployment); break;
  default: console.error("unknown task", process.argv[2]);
}
process.exit(ok ? 0 : 1);
