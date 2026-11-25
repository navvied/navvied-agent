import { createServer } from "node:net";
import type { ToolContext } from "../types.ts";
import { unframe } from "./untrusted.ts";

export interface CallServer {
  /** How many calls the script has made. */
  used(): number;
  /** Whether the script read the web or a connected program: what it prints may then carry text from outside, and is framed as a whole. */
  readWeb(): boolean;
  close(): void;
}

/**
 * Listens on a Unix socket for the calls of one script: one JSON line in (`{tool, args}`), one out (`{ok, text}`). Calls run one at a
 * time and each goes through `call`, which decides which tools can be reached and puts the call through every check a call of the model meets. A call over the `limit` is not run.
 */
export function serveCalls(path: string, call: NonNullable<ToolContext["call"]>, limit: number): Promise<CallServer> {
  let used = 0;
  let readWeb = false;
  let queue: Promise<unknown> = Promise.resolve();
  const answer = async (line: string): Promise<{ ok: boolean; text: string }> => {
    let request: { tool?: unknown; args?: unknown };
    try { request = JSON.parse(line); } catch { return { ok: false, text: "Error: the call was not valid JSON." }; }
    const tool = typeof request.tool === "string" ? request.tool : "";
    if (used >= limit) return { ok: false, text: `Error: this script has made its ${limit} tool calls and may make no more. Do the rest in another ExecuteCode call.` };
    used += 1;
    if (tool === "WebFetch" || tool === "WebSearch" || tool.startsWith("mcp__")) readWeb = true;
    const args = request.args && typeof request.args === "object" && !Array.isArray(request.args) ? (request.args as Record<string, unknown>) : {};
    try { const done = await call(tool, args); return tool.startsWith("mcp__") ? { ...done, text: unframe(done.text) } : done; } catch (e) { return { ok: false, text: `Error: ${e instanceof Error ? e.message : String(e)}` }; }
  };
  const server = createServer((socket) => {
    let pending = "";
    socket.setEncoding("utf8");
    socket.on("error", () => undefined);
    socket.on("data", (chunk: string) => {
      pending += chunk;
      for (let at = pending.indexOf("\n"); at >= 0; at = pending.indexOf("\n")) {
        const line = pending.slice(0, at);
        pending = pending.slice(at + 1);
        queue = queue.then(() => answer(line)).then((r) => { if (!socket.destroyed) socket.write(`${JSON.stringify(r)}\n`); });
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => resolve({ used: () => used, readWeb: () => readWeb, close: () => { server.close(); } }));
  });
}
