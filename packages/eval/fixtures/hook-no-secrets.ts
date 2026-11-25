/** A PreToolUse hook for the offline hook tasks: no tool may read a file that holds real keys (`.env`, but not `.env.example`). */
const call = JSON.parse(await Bun.stdin.text()) as { tool_input?: { file_path?: unknown; path?: unknown; command?: unknown } };
const input = call.tool_input ?? {};
const text = [input.file_path, input.path, input.command].filter((v): v is string => typeof v === "string").join(" ");
if (/(^|[\s"'/\\])\.env(?![\w.-])/.test(text)) console.log(JSON.stringify({ decision: "block", reason: ".env holds real keys and is not to be read; .env.example lists the same names" }));
