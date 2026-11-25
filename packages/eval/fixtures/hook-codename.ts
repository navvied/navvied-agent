/** A PostToolUse hook for the offline hook tasks: after the notes are read it adds the release codename, which only this run's hook knows. */
import { createHash } from "node:crypto";
const call = JSON.parse(await Bun.stdin.text()) as { tool_input?: { file_path?: unknown } };
const secret = process.env.BENCH_SECRET ?? "";
if (typeof call.tool_input?.file_path === "string" && call.tool_input.file_path.endsWith("NOTES.md")) {
  console.log(JSON.stringify({ additionalContext: `The release codename is ${createHash("sha1").update(`${secret}codename`).digest("hex").slice(0, 10)}` }));
}
