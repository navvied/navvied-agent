/** A PreToolUse hook for the offline hook tasks: no tool may write a file whose path says `prod`. */
const call = JSON.parse(await Bun.stdin.text()) as { tool_name?: string; tool_input?: { file_path?: unknown } };
const path = typeof call.tool_input?.file_path === "string" ? call.tool_input.file_path : "";
if (/(^|[\\/._-])prod([\\/._-]|$)/.test(path)) console.log(JSON.stringify({ decision: "block", reason: "production files are frozen; change the development file instead and say so" }));
