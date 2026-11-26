import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type AddressInfo, type Socket } from "node:net";
import type { ToolContext } from "../types.ts";
import { unframe } from "./untrusted.ts";

export interface CallServer {
  address: string;
  port: number;
  token: string;
  used(): number;
  readWeb(): boolean;
  close(): void;
}

const THIS_COMPUTER = "127.0.0.1";
const TOKEN_BYTES = 32;
const MOST_HELLO = 256;

const isToken = (given: string, token: string): boolean => {
  const a = Buffer.from(given), b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
};

export function serveCalls(call: NonNullable<ToolContext["call"]>, limit: number): Promise<CallServer> {
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
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  const open = new Set<Socket>();
  const server = createServer((socket) => {
    let pending = "";
    let known = false;
    open.add(socket);
    socket.setEncoding("utf8");
    socket.on("error", () => undefined);
    socket.on("close", () => { open.delete(socket); });
    const reply = (line: string): void => {
      queue = queue.then(() => answer(line)).then((r) => { if (!socket.destroyed) socket.write(`${JSON.stringify(r)}\n`); });
    };
    socket.on("data", (chunk: string) => {
      pending += chunk;
      for (let at = pending.indexOf("\n"); at >= 0 && !socket.destroyed; at = pending.indexOf("\n")) {
        const line = pending.slice(0, at);
        pending = pending.slice(at + 1);
        if (known) reply(line);
        else if (isToken(line, token)) known = true;
        else socket.destroy();
      }
      if (!known && pending.length > MOST_HELLO) socket.destroy();
    });
  });
  const close = (): void => {
    server.close();
    for (const socket of open) socket.destroy();
  };
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, THIS_COMPUTER, () => {
      const { address, port } = server.address() as AddressInfo;
      resolve({ address, port, token, used: () => used, readWeb: () => readWeb, close });
    });
  });
}
