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
 * How each mode of navvied is put to the program, by what the program documents. `plan` is its own read-only mode and `bypass` is no
 * permission prompts at all, because the person asked. The other three run in its default mode, which refuses what it was not told is
 * fine, and navvied's hook before each tool decides for it: the engine judges every call by the mode (the same `judge` as the built-in
 * engine's), says out loud what may run, and asks the person, in the same card, where the mode asks. If the hook cannot be answered
 * nothing runs. Nothing here is ever more permissive than the mode says.
 */
/** How long a hook may wait for the person to answer, in seconds. */
const HOOK_SECONDS = 3600;

const PERMISSION: Record<PermMode, string[]> = {
  plan: ["--permission-mode", "plan"],
  ask: ["--permission-mode", "default"],
  edits: ["--permission-mode", "default"],
  auto: ["--permission-mode", "default"],
  bypass: ["--dangerously-skip-permissions"],
};

/**
 * The command line that starts the external agent in streaming mode: JSON lines in and out, partial messages, and an echo of
 * each user message so we know when the agent takes it in.
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
    ...PERMISSION[o.mode],
    ...(o.effort ? ["--effort", o.effort] : []),
    ...(o.resume ? ["--resume", o.resume] : []),
    ...(o.persona ? ["--append-system-prompt", o.persona] : []),
    ...(o.guard ? ["--settings", JSON.stringify({ hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: o.guard, timeout: HOOK_SECONDS }] }] } })] : []),
  ];
}
