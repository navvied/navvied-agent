/** A stand-in for the model server: the same arguments, the same lines on its output, the same ends. FAKE_LLAMA says how it misbehaves; FAKE_LLAMA_ARGS is where it writes what it was given. */
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const at = (flag: string): string | undefined => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
if (process.env.FAKE_LLAMA_ARGS) writeFileSync(process.env.FAKE_LLAMA_ARGS, JSON.stringify({ args, pid: process.pid }));
const how = process.env.FAKE_LLAMA ?? "";
const port = Number(at("--port"));
const say = (line: string): void => { process.stderr.write(`0.00.011.630 I ${line}\n`); };

if (args.includes("--version")) { console.log("version: 1.0.0-dev (build 1, commit abc)"); process.exit(0); }
say(`srv  llama_server: initializing ...`);
say(`srv    load_model: loading model '${at("-m")}'`);
if (how === "fail") { say("srv    load_model: error: failed to load model, out of memory"); process.exit(1); }
if (how === "hang") await new Promise(() => undefined);
if (how === "slow") await new Promise((r) => setTimeout(r, 300));
const server = Bun.serve({
  port, hostname: at("--host") ?? "127.0.0.1",
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/health") return Response.json({ status: "ok" });
    if (url.pathname === "/v1/models") return Response.json({ object: "list", data: [{ id: at("-a") ?? "model" }] });
    if (url.pathname === "/v1/chat/completions") return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "hello" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
    return new Response("", { status: 404 });
  },
});
say("srv  server_run_i: model loaded");
say(`srv  server_on_li: listening on http://127.0.0.1:${server.port}`);
process.on("SIGTERM", () => { say("srv    operator(): operator(): cleaning up before exit..."); server.stop(true); process.exit(0); });
