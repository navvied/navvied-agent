import type { Effort, PermMode } from "@navvied/protocol";

export interface ArgvOptions {
  command: string;
  args?: string[];
  model?: string;
  mode: PermMode;
  effort?: Effort;
  resume?: string;
  persona?: string;
  /** A command the program runs before each of its tools; it can stop the tool (see `navvied guard`). */
  guard?: string;
}

/**
 * The command line that starts the external agent in streaming mode: JSON lines in and out, partial messages, and an echo of
 * each user message so we know when the agent takes it in.
 * `plan` maps to the agent's own read-only mode; `auto` runs without permission prompts. `ask` is not available.
 */
export function buildArgv(o: ArgvOptions): string[] {
  return [
    o.command,
    ...(o.args ?? []),
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--replay-user-messages",
    ...(o.model ? ["--model", o.model] : []),
    ...(o.mode === "plan" ? ["--permission-mode", "plan"] : ["--dangerously-skip-permissions"]),
    ...(o.effort ? ["--effort", o.effort] : []),
    ...(o.resume ? ["--resume", o.resume] : []),
    ...(o.persona ? ["--append-system-prompt", o.persona] : []),
    ...(o.guard ? ["--settings", JSON.stringify({ hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: o.guard }] }] } })] : []),
  ];
}
