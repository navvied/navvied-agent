/**
 * The reference solutions of the mc2-* tasks, written as a model without a code tool does them: one tool call at a time, each step
 * decided from what the last one returned. A solution is a generator: it yields the next call and is given the result. It never looks at
 * the generator of the data, only at what the tools answer, so it also shows that the tools carry everything the task needs.
 *
 * Three users: `bun mc2-solve.ts <task>` runs one against the real fixtures (the solution's apply.sh), the scripted model replays one as
 * the plain arm, and the tests count its calls and the size of what came back.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { THRESHOLD_CENTS, KEYWORD } from "./mc2-data.ts";

export interface Step { tool: string; args: Record<string, unknown> }
export type Solver = Generator<Step, void, string>;

const mcp = (tool: string, args: Record<string, unknown>): Step => ({ tool: `mcp__records__${tool}`, args });
/** The text of a call to the connected program, as a model reads it: without the frame round it. */
function* said(tool: string, args: Record<string, unknown>): Generator<Step, string, string> { return unframed(yield mcp(tool, args)); }
const write = (file_path: string, content: string): Step => ({ tool: "Write", args: { file_path, content } });
const readFile = (file_path: string): Step => ({ tool: "Read", args: { file_path } });
const fetchPage = (url: string): Step => ({ tool: "WebFetch", args: { url } });

/** The text of a web result without the frame the program puts round it. */
const unframed = (text: string): string => text.replace(/^<navvied-web [^>]*>\n(text from [^\n]*\n)?/, "").replace(/\n<\/navvied-web>\s*$/, "");
const baseOf = (readResult: string): string => /(https?:\/\/[^\s"']+)/.exec(readResult)![1]!.replace(/\/+$/, "");
const csv = (rows: string[][]): string => `${rows.map((r) => r.join(",")).join("\n")}\n`;
const unpaidOf = (invoices: string): number => (JSON.parse(invoices) as { invoices: { status: string; total_cents: number }[] }).invoices.filter((i) => i.status === "open" || i.status === "overdue").reduce((s, i) => s + i.total_cents, 0);

type Account = { id: string; region: string; plan: string; billing: { balance_due_cents: number }; flags: { audit_hold: boolean } };

function* walk(): Generator<Step, string[], string> {
  const ids: string[] = [];
  for (let page: number | null = 1; page;) { const r = JSON.parse(yield* said("list_accounts", { page })) as { accounts: string[]; next_page: number | null }; ids.push(...r.accounts); page = r.next_page; }
  return ids;
}

function* fanOut(): Solver {
  const over: string[] = [];
  for (const id of yield* walk()) { const a = JSON.parse(yield* said("get_account", { id })) as Account; if (a.billing.balance_due_cents > THRESHOLD_CENTS) over.push(a.id); }
  yield write("over.txt", `${over.sort().join("\n")}\n`);
}

function* pageWalk(): Solver {
  // The list is walked one page at a time and stops at the first account on hold, so the pages after it are never asked for.
  for (let page: number | null = 1; page;) {
    const r = JSON.parse(yield* said("list_accounts", { page })) as { accounts: string[]; next_page: number | null };
    for (const id of r.accounts) {
      const a = JSON.parse(yield* said("get_account", { id })) as Account;
      if (!a.flags.audit_hold) continue;
      const unpaid = unpaidOf(yield* said("get_invoices", { account_id: id }));
      yield write("hold.json", JSON.stringify({ account: id, unpaid_cents: unpaid }));
      return;
    }
    page = r.next_page;
  }
}

function* ticketPipeline(): Solver {
  const found = JSON.parse(yield* said("search_tickets", { query: KEYWORD })) as { tickets: { id: string; account_id: string; status: string }[] };
  const rows: string[][] = [["ticket", "account", "region", "unpaid_cents"]];
  for (const t of found.tickets.filter((x) => x.status === "open").sort((a, b) => a.id.localeCompare(b.id))) {
    const a = JSON.parse(yield* said("get_account", { id: t.account_id })) as Account;
    rows.push([t.id, t.account_id, a.region, String(unpaidOf(yield* said("get_invoices", { account_id: t.account_id })))]);
  }
  yield write("report.csv", csv(rows));
}

function* comparePages(): Solver {
  const base = baseOf(yield readFile("docs-url.txt"));
  const seen: [number, number][] = [];
  for (let n = 1; n <= 12; n++) seen.push([n, Number(/cache_ttl_seconds: (\d+)/.exec(unframed(yield fetchPage(`${base}/status/${n}`)))![1])]);
  const count = new Map<number, number>();
  for (const [, ttl] of seen) count.set(ttl, (count.get(ttl) ?? 0) + 1);
  const odd = seen.find(([, ttl]) => count.get(ttl) === 1)!;
  yield write("ANSWER.txt", `${odd[0]} ${odd[1]}\n`);
}

function* pagesToAccounts(): Solver {
  const base = baseOf(yield readFile("docs-url.txt"));
  const rows: string[][] = [["page", "account", "plan"]];
  for (let n = 1; n <= 12; n++) {
    const id = /Billing account: (AC-\d+)/.exec(unframed(yield fetchPage(`${base}/status/${n}`)))![1]!;
    rows.push([String(n), id, (JSON.parse(yield* said("get_account", { id })) as Account).plan]);
  }
  yield write("plans.csv", csv(rows));
}

function* firstAccount(): Solver {
  const first = (JSON.parse(yield* said("list_accounts", { page: 1 })) as { accounts: string[] }).accounts[0]!;
  const found = JSON.parse(yield* said("search_tickets", { query: first })) as { tickets: { id: string }[] };
  yield write("tickets.txt", `${found.tickets.map((t) => t.id).sort().join("\n")}\n`);
}

/** The tasks of the other connected program (see mcp-depth.ts): resources, a prompt and a tool among dozens. */
const ops = (tool: string, args: Record<string, unknown>): Step => ({ tool: `mcp__ops__${tool}`, args });

function* resourceVersion(): Solver {
  const notes = unframed(yield { tool: "mcp__resources", args: { action: "read", uri: "docs://release-notes" } });
  yield write("VERSION.txt", `${/Current version: (\S+)/.exec(notes)![1]}\n`);
}

function* deferredArchive(): Solver {
  yield { tool: "mcp__find", args: { query: "archive log" } };
  const done = unframed(yield ops("archive_log", { name: "audit" }));
  yield write("archive.txt", `${/(ARC-\w+)/.exec(done)![1]}\n`);
}

function* promptStep(): Solver {
  const text = unframed(yield { tool: "mcp__prompts", args: { action: "get", name: "release-checklist", arguments: { version: "2.4" } } });
  yield write("step.txt", `${/Step 1: run `([^`]+)`/.exec(text)![1]}\n`);
}

export const SOLVERS: Record<string, () => Solver> = {
  "mcp-resource-version": resourceVersion, "mcp-deferred-archive": deferredArchive, "mcp-prompt-step": promptStep,
  "mc2-fan-out": fanOut, "mc2-page-walk": pageWalk, "mc2-ticket-pipeline": ticketPipeline,
  "mc2-compare-pages": comparePages, "mc2-pages-to-accounts": pagesToAccounts, "mc2-first-account": firstAccount,
};

/** A fresh run of the solution of a task, or nothing when the task has none of this kind. */
export const solver = (task: string): Solver | undefined => SOLVERS[task]?.();

/** Runs a solution to its end, giving each call to `run`; says how many calls it made and how many characters came back. */
export async function drive(solution: Solver, run: (step: Step) => Promise<string>): Promise<{ calls: number; chars: number; results: number[] }> {
  const results: number[] = [];
  let next = solution.next();
  while (!next.done) {
    const text = await run(next.value);
    results.push(text.length);
    next = solution.next(text);
  }
  return { calls: results.length, chars: results.reduce((a, b) => a + b, 0), results };
}

if (import.meta.main) {
  const { McpClient } = await import("../../engine/src/mcp.ts");
  const task = process.argv[2] ?? "";
  const solution = solver(task);
  if (!solution) { console.error(`unknown task ${task}`); process.exit(2); }
  const depth = task.startsWith("mcp-");
  const client = await McpClient.start(depth ? "ops" : "records", { command: process.execPath, args: [join(dirname(import.meta.path), depth ? (task === "mcp-deferred-archive" ? "mcp-depth-many.ts" : "mcp-depth.ts") : "mcp-records.ts")] });
  const none = new AbortController().signal;
  try {
    await drive(solution, async (step) => {
      if (step.tool === "mcp__find") return "";
      if (step.tool === "mcp__resources") return (await client.readResource(String(step.args.uri), none)).map((c) => (c as { resource?: { text?: string } }).resource?.text ?? "").join("\n");
      if (step.tool === "mcp__prompts") return (await client.getPrompt(String(step.args.name), step.args.arguments as Record<string, string>, none)).messages.map((m) => (m.content as { text?: string }).text ?? "").join("\n");
      if (step.tool.startsWith("mcp__records__") || step.tool.startsWith("mcp__ops__")) return client.call(step.tool.replace(/^mcp__\w+?__/, ""), step.args, none);
      if (step.tool === "Write") { writeFileSync(String(step.args.file_path), String(step.args.content)); return "ok"; }
      if (step.tool === "Read") return readFileSync(String(step.args.file_path), "utf8");
      return (await fetch(String(step.args.url))).text();
    });
  } finally { client.close(); }
}
