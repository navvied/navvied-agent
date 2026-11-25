/** A PreToolUse hook for the offline hook tasks: a report written under reports/ gets the stamp of this run as its first line. */
import { createHash } from "node:crypto";
const call = JSON.parse(await Bun.stdin.text()) as { tool_input?: { file_path?: unknown; content?: unknown } };
const { file_path: path, content } = call.tool_input ?? {};
if (typeof path === "string" && typeof content === "string" && /(^|[\\/])reports[\\/]/.test(path)) {
  const stamp = createHash("sha1").update(`${process.env.BENCH_SECRET ?? ""}stamp`).digest("hex").slice(0, 10);
  console.log(JSON.stringify({ updatedInput: { content: `# Report ${stamp}\n${content}` } }));
}
