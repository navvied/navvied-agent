/**
 * A small MCP server for the second measurement: accounts, invoices and tickets made from the run's secret (see mc2-data.ts).
 * It speaks newline-delimited JSON-RPC on standard input and output, the part of the protocol the agent's client uses, and ends when
 * its input closes. It has no dependencies. The secret comes from BENCH_SECRET in its environment.
 */
import { answerFor, world } from "./mc2-data.ts";

const w = world(process.env.BENCH_SECRET ?? "");

const object = (properties: Record<string, unknown>, required: string[]): Record<string, unknown> => ({ type: "object", properties, required });
export const TOOLS = [
  { name: "list_accounts", description: "List the account ids, ten to a page. The answer carries next_page, or null on the last page.", inputSchema: object({ page: { type: "integer", description: "page number, from 1" } }, ["page"]), annotations: { readOnlyHint: true } },
  { name: "get_account", description: "The full record of one account.", inputSchema: object({ id: { type: "string" } }, ["id"]), annotations: { readOnlyHint: true } },
  { name: "get_invoices", description: "The invoices of one account, with their lines.", inputSchema: object({ account_id: { type: "string" } }, ["account_id"]), annotations: { readOnlyHint: true } },
  { name: "search_tickets", description: "Support tickets whose account, subject or text contains the query.", inputSchema: object({ query: { type: "string" } }, ["query"]), annotations: { readOnlyHint: true } },
];

/** What a call answers: the text, or the reason it failed. */
function call(name: string, args: Record<string, unknown>): { text: string; error?: true } {
  const fail = (text: string): { text: string; error: true } => ({ text, error: true });
  if (name === "list_accounts") {
    const page = Number(args.page);
    return Number.isInteger(page) && page >= 1 && (page - 1) * 10 < w.order.length ? { text: answerFor.list_accounts(w, page) } : fail(`there is no page ${String(args.page)}`);
  }
  if (name === "get_account") { const text = answerFor.get_account(w, String(args.id)); return text ? { text } : fail(`no account ${String(args.id)}`); }
  if (name === "get_invoices") { const text = answerFor.get_invoices(w, String(args.account_id)); return text ? { text } : fail(`no account ${String(args.account_id)}`); }
  if (name === "search_tickets") return typeof args.query === "string" && args.query ? { text: answerFor.search_tickets(w, args.query) } : fail("query is needed");
  return fail(`no tool ${name}`);
}

if (import.meta.main) {
  const send = (m: unknown): void => { process.stdout.write(`${JSON.stringify(m)}\n`); };
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("end", () => process.exit(0));
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      if (!line) continue;
      const m = JSON.parse(line) as { id?: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
      if (m.id === undefined) continue;
      if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "records", version: "1" } } });
      else if (m.method === "tools/list") send({ jsonrpc: "2.0", id: m.id, result: { tools: TOOLS } });
      else if (m.method === "tools/call") { const r = call(m.params?.name ?? "", m.params?.arguments ?? {}); send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: r.text }], ...(r.error ? { isError: true } : {}) } }); }
      else send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "unknown method" } });
    }
  });
}
