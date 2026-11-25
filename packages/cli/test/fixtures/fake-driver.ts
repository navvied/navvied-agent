#!/usr/bin/env bun
// A stand-in for the real driver: the same command line and the same protocol, nothing else. `status` answers once `serve` has made its socket marker.
import { existsSync, writeFileSync, rmSync } from "node:fs";
const [cmd, ...rest] = process.argv.slice(2);
const sock = rest[rest.indexOf("--socket") + 1]!;
if (cmd === "serve") {
  if (process.env.CUA_DRIVER_EMBEDDED !== "1" || !rest.includes("--embedded") || !rest.includes("--parent-liveness-stdio")) process.exit(2);
  writeFileSync(sock + ".ready", String(process.pid));
  writeFileSync(sock + ".env", JSON.stringify(Object.keys(process.env)));
  process.stdin.on("end", () => { rmSync(sock + ".ready", { force: true }); writeFileSync(sock + ".ended", "1"); process.exit(0); });
  process.stdin.resume();
} else if (cmd === "status") {
  process.exit(existsSync(sock + ".ready") ? 0 : 1);
} else if (cmd === "mcp") {
  let buf = "";
  process.stdin.on("data", (d) => {
    buf += d; for (let n = buf.indexOf("\n"); n >= 0; n = buf.indexOf("\n")) {
      const m = JSON.parse(buf.slice(0, n)); buf = buf.slice(n + 1);
      if (m.id === undefined) continue;
      const tools = [{ name: "click", inputSchema: { properties: { pid: {}, delivery_mode: {} } } }, { name: "type_text", inputSchema: { properties: { pid: {}, text: {}, delivery_mode: {} } } }];
      const result = m.method === "tools/list" ? { tools } : m.method === "tools/call" ? { content: [{ type: "text", text: "ok" }] } : {};
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\n");
    }
  });
}
