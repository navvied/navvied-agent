#!/usr/bin/env bun
/**
 * A stand-in for an external agent that streams JSON lines. It behaves like one — nothing is printed until the first user
 * message, user messages are echoed back, a turn ends with a `result` — and obeys keywords in the message so tests can
 * drive every path. Each start appends its command line to $FAKE_ARGV_LOG.
 */
import { appendFileSync } from "node:fs";

const argv = process.argv.slice(2);
if (process.env.FAKE_ARGV_LOG) appendFileSync(process.env.FAKE_ARGV_LOG, `${JSON.stringify(argv)}\n`);
const flag = (name: string): string | undefined => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const planMode = flag("--permission-mode") === "plan";
const sessionId = flag("--resume") ?? crypto.randomUUID();

const out = (o: unknown) => process.stdout.write(`${JSON.stringify(o)}\n`);
const usage = { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 0, output_tokens: 5 };
const result = (subtype = "success", extra: Record<string, unknown> = {}) => out({ type: "result", subtype, ...extra });
let started = false;
let slowTimer: ReturnType<typeof setTimeout> | undefined;

/** A command line cut into words the way a shell does it for the cases here: spaces separate, quotes keep words together, and a backslash is just a character (a Windows path). */
function words(line: string): string[] {
  const out: string[] = [];
  let current = "", quote = "", started = false;
  for (const c of line) {
    if (quote) { if (c === quote) quote = ""; else current += c; }
    else if (c === '"' || c === "'") { quote = c; started = true; }
    else if (c === " " || c === "\t") { if (started || current) out.push(current); current = ""; started = false; }
    else current += c;
  }
  if (started || current) out.push(current);
  return out;
}

/**
 * What the real program does with a hook, by what its documentation says: it runs the hook before the tool with the call on standard input.
 * Exit 2 stops the tool and says why; a decision on standard output may allow it (and change its input); any other end (the hook could not
 * start, or failed) is an error that does not stop the tool, and then the tool is left to the program's own permission mode: in its default
 * mode a tool that needs permission is refused (nobody can be asked), and only with its permission prompts turned off does it run.
 */
async function viaHook(command: string, id: string) {
  const settings = flag("--settings");
  const hook = settings ? (JSON.parse(settings) as { hooks: { PreToolUse: { hooks: { command: string }[] }[] } }).hooks.PreToolUse[0]!.hooks[0]!.command : undefined;
  const promptsOff = argv.includes("--dangerously-skip-permissions");
  let input: Record<string, unknown> = { command };
  let stopped: string | undefined;
  let allowed = false;
  if (hook) {
    let code: number | null = null, stdout = "", stderr = "";
    try {
      const child = Bun.spawn(words(hook), { stdin: new TextEncoder().encode(JSON.stringify({ tool_name: "Bash", tool_input: input, tool_use_id: id, cwd: process.cwd() })), stdout: "pipe", stderr: "pipe", env: process.env });
      [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
      code = await child.exited;
    } catch { /* the hook could not start */ }
    if (code === 2) stopped = stderr.trim();
    else if (code === 0 && stdout.trim()) { const decision = (JSON.parse(stdout) as { hookSpecificOutput?: { permissionDecision?: string; updatedInput?: Record<string, unknown> } }).hookSpecificOutput; allowed = decision?.permissionDecision === "allow"; if (decision?.updatedInput) input = decision.updatedInput; }
  }
  if (stopped === undefined && !allowed && !promptsOff && flag("--permission-mode") !== "plan") stopped = "Permission to use Bash has been denied.";
  out({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "Bash", input: { command } }], usage } });
  out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, is_error: stopped !== undefined, content: stopped ?? `ran: ${String(input.command)}` }] } });
  out({ type: "assistant", message: { content: [{ type: "text", text: stopped ? "stopped" : "ran it" }], usage } });
  result();
}

function reply(text: string, content: Record<string, unknown>[]) {
  const t = text.toLowerCase();
  const asked = /run bash: (.+)/i.exec(text);
  if (asked) { void viaHook(asked[1]!.trim(), `hook${Math.random().toString(36).slice(2, 8)}`); return; }
  if (t.includes("die")) { process.stderr.write("boom: something broke\n"); process.exit(3); }
  if (t.includes("stubborn")) return; // never answers, ignores interrupts
  if (t.includes("slow")) { slowTimer = setTimeout(() => { out({ type: "assistant", message: { content: [{ type: "text", text: "finally" }], usage } }); result(); }, 3000); return; }
  if (t.includes("toolong")) { out({ type: "assistant", message: { content: [{ type: "text", text: "Prompt is too long" }], usage } }); return result(); }
  if (t.includes("fail")) return result("error_max_turns", { result: "too many turns" });
  if (t.includes("image")) {
    const n = content.filter((c) => c.type === "image").length;
    out({ type: "assistant", message: { content: [{ type: "text", text: `saw ${n} image(s)` }], usage } });
    return result();
  }
  if (t.includes("sub")) {
    out({ type: "assistant", parent_tool_use_id: "task1", message: { content: [{ type: "tool_use", id: "s1", name: "Read", input: { file_path: "a.ts" } }] } });
    out({ type: "user", parent_tool_use_id: "task1", message: { content: [{ type: "tool_result", tool_use_id: "s1", content: "contents" }] } });
    out({ type: "assistant", message: { content: [{ type: "text", text: "sub done" }], usage } });
    return result();
  }
  if (t.includes("plan")) {
    if (planMode) {
      out({ type: "assistant", message: { content: [{ type: "tool_use", id: "p1", name: "ExitPlanMode", input: { plan: "1. First\n2. Second" } }], usage } });
      out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "p1", is_error: true, content: "requires approval" }] } });
      return result();
    }
    out({ type: "assistant", message: { content: [{ type: "text", text: "not planning" }], usage } });
    return result();
  }
  if (t.includes("tool")) {
    out({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "Bash" } } });
    out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"command":' } } });
    out({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }], usage } });
    out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "file1\nfile2" }] }] } });
    out({ type: "assistant", message: { content: [{ type: "text", text: "listed" }], usage } });
    return result();
  }
  // default: stream the text in pieces, then the whole message (like the real thing), then finish
  out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } } });
  out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } } });
  out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } } });
  out({ type: "assistant", message: { content: [{ type: "text", text: "Hello" }], usage } });
  result();
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buf += chunk;
  let i: number;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.type === "control_request" && msg.request?.subtype === "interrupt") {
      if (slowTimer) { clearTimeout(slowTimer); slowTimer = undefined; result("error_during_execution"); }
      continue;
    }
    if (msg.type !== "user") continue;
    if (!started) { started = true; process.stdout.write("WARNING: not json, must be ignored\n"); out({ type: "system", subtype: "init", session_id: sessionId }); }
    out({ type: "user", isReplay: true, uuid: msg.uuid, message: msg.message });
    const content: Record<string, unknown>[] = msg.message?.content ?? [];
    reply(content.map((c) => String(c.text ?? "")).join(" "), content);
  }
});
process.stdin.on("end", () => process.exit(0));
