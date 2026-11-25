/**
 * A small MCP server that asks things of the agent instead of only answering: its tool `condense` asks the agent's model for an answer
 * (`sampling/createMessage`) and its tool `deploy` asks the person for a confirmation and a password (`elicitation/create`). Its answers are made from the run's
 * secret (BENCH_SECRET), so they cannot be guessed. It speaks newline-delimited JSON-RPC on standard input and output and ends when its input closes.
 */
import { createHash } from "node:crypto";

const digest = (secret: string, what: string): string => createHash("sha256").update(`${secret}:${what}`).digest("hex");

/** What the run's secret decides. The checks work the same answers out again. */
export const facts = (secret: string): { code: string; deployment: string } => ({ code: `CODE-${digest(secret, "sample").slice(0, 8)}`, deployment: `DEP-${digest(secret, "deploy").slice(0, 8)}` });

const object = (properties: Record<string, unknown>, required: string[]): Record<string, unknown> => ({ type: "object", properties, required });

export function serve(): void {
  const f = facts(process.env.BENCH_SECRET ?? "");
  const tools = [
    { name: "condense", description: "Condense a ticket into one code word.", inputSchema: object({ ticket: { type: "string" } }, ["ticket"]) },
    { name: "deploy", description: "Deploy a build to a target; the person confirms it.", inputSchema: object({ target: { type: "string" } }, ["target"]) },
  ];
  const send = (m: unknown): void => { process.stdout.write(`${JSON.stringify(m)}\n`); };
  const waiting = new Map<number, (m: { result?: Record<string, unknown>; error?: { message: string } }) => void>();
  let asked = 0;
  const request = (method: string, params: unknown): Promise<{ result?: Record<string, unknown>; error?: { message: string } }> => new Promise((resolve) => { const id = ++asked; waiting.set(id, resolve); send({ jsonrpc: "2.0", id, method, params }); });
  const text = (id: number, words: string, isError = false): void => send({ jsonrpc: "2.0", id, result: { ...(isError ? { isError } : {}), content: [{ type: "text", text: words }] } });
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("end", () => process.exit(0));
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      if (!line) continue;
      const m = JSON.parse(line) as { id?: number; method?: string; params?: { name?: string; arguments?: Record<string, string> } };
      if (m.method === undefined && m.id !== undefined) { waiting.get(m.id)?.(m as never); waiting.delete(m.id); continue; }
      if (m.id === undefined) continue;
      const id = m.id;
      if (m.method === "initialize") send({ jsonrpc: "2.0", id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "lab", version: "1" } } });
      else if (m.method === "tools/list") send({ jsonrpc: "2.0", id, result: { tools } });
      else if (m.method === "tools/call" && m.params?.name === "condense") {
        void request("sampling/createMessage", { messages: [{ role: "user", content: { type: "text", text: `Reply with only this code: ${f.code}` } }], maxTokens: 20 }).then((r) => {
          const said = (r.result?.content as { text?: string } | undefined)?.text;
          if (said) text(id, `condensed: ${said.trim()}`); else text(id, `could not condense: ${r.error?.message ?? "no answer"}`, true);
        });
      } else if (m.method === "tools/call" && m.params?.name === "deploy") {
        void request("elicitation/create", { message: `Deploy to ${m.params.arguments?.target ?? "?"}?`, requestedSchema: object({ confirm: { type: "boolean", title: "Confirm" }, password: { type: "string", title: "Deploy password" } }, ["confirm", "password"]) }).then((r) => {
          const action = (r.result as { action?: string } | undefined)?.action ?? "error";
          if (action === "accept") text(id, `deployed: ${f.deployment}`); else text(id, `not deployed: the person did not accept (${action})`, true);
        });
      } else send({ jsonrpc: "2.0", id, error: { code: -32601, message: "unknown request" } });
    }
  });
}

if (import.meta.main) serve();
