// A small MCP server for tests: newline-delimited JSON-RPC on standard input and output.
const mode = process.env.FAKE_MODE ?? "";
if (mode === "silent") setInterval(() => {}, 1000);
else {
  const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
  const tools = [
    { name: "echo", description: "Say it back", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }, annotations: { readOnlyHint: true } },
    { name: "add numbers", description: "Add two numbers", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } } },
    { name: "fail", description: "Always fails" },
    { name: "slow", description: "Never answers in time" },
    { name: "big", description: "A very long answer" },
    { name: "picture", description: "Returns an image" },
  ];
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
      const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
      if (!line.trim()) continue;
      const m = JSON.parse(line);
      if (m.id === undefined) { if (m.method === "notifications/cancelled" && process.env.CANCEL_LOG) require("fs").appendFileSync(process.env.CANCEL_LOG, `${m.params.requestId}\n`); continue; }
      if (m.method === "initialize") { send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } } }); if (mode === "crash") setTimeout(() => process.exit(3), 30); }
      else if (m.method === "tools/list") {
        if (mode === "paged" && !m.params?.cursor) send({ jsonrpc: "2.0", id: m.id, result: { tools: tools.slice(0, 2), nextCursor: "page2" } });
        else if (mode === "paged") send({ jsonrpc: "2.0", id: m.id, result: { tools: tools.slice(2) } });
        else send({ jsonrpc: "2.0", id: m.id, result: { tools } });
      } else if (m.method === "tools/call") {
        const { name, arguments: a } = m.params;
        if (name === "echo") send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: `echo: ${a.text}` }] } });
        else if (name === "add numbers") send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: String(a.a + a.b) }] } });
        else if (name === "fail") send({ jsonrpc: "2.0", id: m.id, result: { isError: true, content: [{ type: "text", text: "it broke" }] } });
        else if (name === "big") send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "x".repeat(100000) }] } });
        else if (name === "picture") send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "image", data: "AA==", mimeType: "image/png" }, { type: "text", text: "here" }] } });
        else if (name === "slow") { /* no answer */ }
        else send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `no tool ${name}` } });
      } else send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "unknown method" } });
    }
  });
}
