/** The checks of the mc2-* tasks: `bun mc2-check.ts <task>`, run in the workspace. The expected answer is worked out again from the run's secret. */
import { readFileSync } from "node:fs";
import { expected } from "./mc2-data.ts";

const secret = process.env.BENCH_SECRET ?? "";
const read = (name: string): string => { try { return readFileSync(name, "utf8"); } catch { return ""; } };
const lines = (text: string): string[] => text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const table = (name: string): string[][] => lines(read(name)).map((l) => l.split(",").map((c) => c.trim()));

let ok = false;
switch (process.argv[2]) {
  case "fan-out": ok = same(lines(read("over.txt")).sort(), expected.over(secret)); break;
  case "page-walk": try { ok = same(JSON.parse(read("hold.json")), expected.hold(secret)); } catch { ok = false; } break;
  case "ticket-pipeline": ok = same(table("report.csv"), [["ticket", "account", "region", "unpaid_cents"], ...expected.chargebacks(secret)]); break;
  case "compare-pages": { const want = expected.odd(secret); ok = /^\s*\d+\D+\d+\s*$/.test(read("ANSWER.txt")) && same((read("ANSWER.txt").match(/\d+/g) ?? []).map(Number), [want.page, want.ttl]); break; }
  case "pages-to-accounts": ok = same(table("plans.csv"), [["page", "account", "plan"], ...expected.plans(secret)]); break;
  case "first-account": ok = same(lines(read("tickets.txt")).sort(), expected.first(secret)); break;
  default: console.error("unknown task", process.argv[2]);
}
process.exit(ok ? 0 : 1);
