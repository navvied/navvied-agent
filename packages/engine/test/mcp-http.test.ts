import { afterAll, describe, expect, test } from "bun:test";
import { McpHttpClient, connectMcp } from "../src/index.ts";

const seen: { method: string; session: string | null; auth: string | null; protocol: string | null }[] = [];
let closed = false;
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    if (req.method === "DELETE") { closed = true; return new Response(null, { status: 204 }); }
    if (req.headers.get("authorization") !== "Bearer secret-token") return new Response("no", { status: 401 });
    const msg = (await req.json()) as { id?: number; method: string; params?: { name?: string; arguments?: { text?: string } } };
    seen.push({ method: msg.method, session: req.headers.get("mcp-session-id"), auth: req.headers.get("authorization"), protocol: req.headers.get("mcp-protocol-version") });
    if (msg.id === undefined) return new Response(null, { status: 202 });
    const reply = (result: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }), { headers: { "content-type": "application/json", ...headers } });
    if (msg.method === "initialize") return reply({ protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "fake" } }, { "mcp-session-id": "sess-1" });
    if (msg.method === "tools/list") return reply({ tools: [{ name: "echo", description: "Echo text", inputSchema: { type: "object", properties: { text: { type: "string" } } }, annotations: { readOnlyHint: true } }, { name: "stream", description: "Answers as a stream" }] });
    if (msg.method === "tools/call" && msg.params?.name === "stream") {
      const body = `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: {} })}\n\nevent: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "from the stream" }] } })}\n\n`;
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    }
    if (msg.method === "tools/call") return reply({ content: [{ type: "text", text: `echo: ${msg.params?.arguments?.text}` }] });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { message: "unknown method" } }), { headers: { "content-type": "application/json" } });
  },
});
afterAll(() => server.stop(true));
const url = `http://127.0.0.1:${server.port}/mcp`;
const headers = { authorization: "Bearer secret-token" };

describe("a connected program reached over the web", () => {
  test("the handshake, the session id, the headers and the tools list work, and a call returns its text", async () => {
    const client = await McpHttpClient.start("web", { url, headers });
    expect((await client.tools()).map((t) => t.name)).toEqual(["echo", "stream"]);
    expect(await client.call("echo", { text: "hi" }, new AbortController().signal)).toBe("echo: hi");
    const later = seen.filter((s) => s.method !== "initialize");
    expect(later.every((s) => s.session === "sess-1" && s.auth === "Bearer secret-token" && s.protocol === "2025-03-26")).toBe(true);
    expect(seen.map((s) => s.method)).toContain("notifications/initialized");
    client.close();
    await new Promise((r) => setTimeout(r, 100));
    expect(closed).toBe(true);
  });
  test("an answer that comes as an event stream is read until the right message", async () => {
    const client = await McpHttpClient.start("web", { url, headers });
    expect(await client.call("stream", {}, new AbortController().signal)).toBe("from the stream");
    client.close();
  });
  test("a wrong token says what to check, and a server that cannot be reached says so", async () => {
    await expect(McpHttpClient.start("web", { url, headers: { authorization: "Bearer wrong" } })).rejects.toThrow("did not accept the token");
    await expect(McpHttpClient.start("web", { url: "http://127.0.0.1:1/mcp" })).rejects.toThrow("could not be reached");
    await expect(McpHttpClient.start("web", { url: "ftp://x" })).rejects.toThrow("http");
  });
  test("its tools join the engine's, named like the others, and a failing server is a problem, not a crash", async () => {
    const conn = await connectMcp({ web: { url, headers }, broken: { url: "http://127.0.0.1:1/mcp" } });
    expect(conn.tools.map((t) => t.name).sort()).toEqual(["mcp__web__echo", "mcp__web__stream"]);
    expect(conn.tools.find((t) => t.name === "mcp__web__echo")!.readOnly).toBe(true);
    expect(conn.problems.map((p) => p.server)).toEqual(["broken"]);
    conn.close();
  });
});
