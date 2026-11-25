/**
 * A small MCP server for the tasks about resources, prompts and long tool lists: release notes as a resource, a checklist as a prompt, and
 * log archiving as a tool. Every answer is made from the run's secret (BENCH_SECRET), so it cannot be guessed. With `many`, thirty-six tools of
 * no use are listed beside it, enough for the agent to search its tools instead of seeing them all. It speaks newline-delimited JSON-RPC on
 * standard input and output and ends when its input closes.
 */
import { createHash } from "node:crypto";

const digest = (secret: string, what: string): string => createHash("sha256").update(`${secret}:${what}`).digest("hex");

/** What the run's secret decides. The checks work the same answers out again. */
export const facts = (secret: string): { version: string; archive: (name: string) => string; step: string } => ({
  version: `${1 + (parseInt(digest(secret, "major").slice(0, 4), 16) % 8)}.${parseInt(digest(secret, "minor").slice(0, 4), 16) % 20}.${parseInt(digest(secret, "patch").slice(0, 4), 16) % 30}`,
  archive: (name) => `ARC-${digest(secret, `archive:${name}`).slice(0, 8)}`,
  step: `make ${digest(secret, "step").slice(0, 6)}`,
});

const object = (properties: Record<string, unknown>, required: string[]): Record<string, unknown> => ({ type: "object", properties, required });

export function serve(many: boolean): void {
  const f = facts(process.env.BENCH_SECRET ?? "");
  const tools: Record<string, unknown>[] = [
    { name: "archive_log", description: "Compress a log file of the service and return the id of the archive.", inputSchema: object({ name: { type: "string", description: "the log's name" } }, ["name"]) },
    ...(many ? Array.from({ length: 36 }, (_, i) => ({ name: `metric_${i}`, description: `Reads the metric number ${i} of the service dashboard.`, inputSchema: object({ window: { type: "string", description: "such as 5m or 1h" } }, []) })) : []),
  ];
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
      const m = JSON.parse(line) as { id?: number; method: string; params?: { name?: string; uri?: string; arguments?: Record<string, string> } };
      if (m.id === undefined) continue;
      const reply = (result: unknown): void => send({ jsonrpc: "2.0", id: m.id, result });
      if (m.method === "initialize") reply({ protocolVersion: "2025-03-26", capabilities: { tools: {}, resources: {}, prompts: {} }, serverInfo: { name: "ops", version: "1" } });
      else if (m.method === "tools/list") reply({ tools });
      else if (m.method === "tools/call") {
        if (m.params?.name === "archive_log" && m.params.arguments?.name) reply({ content: [{ type: "text", text: `archived ${m.params.arguments.name}: ${f.archive(m.params.arguments.name)}` }] });
        else reply({ isError: true, content: [{ type: "text", text: `no use for ${m.params?.name ?? "that"}` }] });
      } else if (m.method === "resources/list") reply({ resources: [{ uri: "docs://release-notes", name: "Release notes", mimeType: "text/plain", description: "What changed in the current release" }] });
      else if (m.method === "resources/templates/list") reply({ resourceTemplates: [] });
      else if (m.method === "resources/read" && m.params?.uri === "docs://release-notes") reply({ contents: [{ uri: "docs://release-notes", mimeType: "text/plain", text: `Release notes\n\nCurrent version: ${f.version}\nFixed: slow start, a crash on empty input.\n` }] });
      else if (m.method === "prompts/list") reply({ prompts: [{ name: "release-checklist", description: "The steps to release a version", arguments: [{ name: "version", required: true }] }] });
      else if (m.method === "prompts/get" && m.params?.name === "release-checklist") reply({ messages: [{ role: "user", content: { type: "text", text: `Release checklist for version ${m.params.arguments?.version ?? "?"}.\nStep 1: run \`${f.step}\`.\nStep 2: tag the commit.\nStep 3: announce it.` } }] });
      else send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "unknown request" } });
    }
  });
}

if (import.meta.main) serve(false);
