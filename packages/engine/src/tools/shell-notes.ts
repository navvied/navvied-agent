import { programName, shellView } from "../shell-scan.ts";

/** Programs whose exit code 1 is an answer, not a failure: said in words, so a model does not take "no matches" for a broken command. */
const ANSWERS: [RegExp, string][] = [[/^(grep|egrep|fgrep|rg|ag)$/, "no matches"], [/^(diff|cmp)$/, "the files differ"], [/^(test|\[)$/, "the condition is false"]];

/** What a signal that ends a program usually means, and the exit codes a shell gives for them (128 and the signal number). */
const SIGNALS: Record<string, string> = { SIGHUP: "its terminal closed", SIGINT: "interrupted", SIGABRT: "it aborted", SIGKILL: "killed, often because the machine ran out of memory", SIGSEGV: "it crashed (segmentation fault)", SIGPIPE: "something it wrote to closed early", SIGTERM: "asked to stop" };
const CODES: Record<number, string> = { 129: "SIGHUP", 130: "SIGINT", 134: "SIGABRT", 137: "SIGKILL", 139: "SIGSEGV", 141: "SIGPIPE", 143: "SIGTERM" };

/** The word that comes after the exit code: what the code means, when it means something. Empty when the code says nothing more. */
export function exitNote(command: string, code: number | null, output: string, signal?: string): string {
  if (code === null) return signal ? `: ${SIGNALS[signal] ?? "ended by a signal"}` : "";
  if (code === 127) {
    const name = /(\S+): (?:command )?not found/.exec(output)?.[1]?.replace(/^.*[:/]/, "") ?? "";
    return `: ${name ? `"${name}"` : "a program in it"} is not installed or not on PATH`;
  }
  if (code === 126) return ": found, but it cannot be run (no permission, or not a program)";
  if (code === 124) return ": it ran out of its time (timeout)";
  const named = CODES[code];
  if (named) return `, ${named}: ${SIGNALS[named]}`;
  if (code !== 1) return "";
  const last = shellView(command).cmds.at(-1);
  const hit = last && ANSWERS.find(([re]) => re.test(programName(last.words[0] ?? "")));
  return hit ? `: ${hit[1]}, not a failure` : "";
}

const FILTERS = /\|\s*(?:tail|head|tee|cat|wc|sort|uniq|cut|tr|less|more)\b[^|;&]*$/;
const FAILED = /\b(?:error|failed|failure|fatal|traceback|exception|panic)\b|npm ERR!|FAIL\b/i;

/**
 * An exit of 0 that only describes the last program of a pipeline: `make | tail` is 0 when make failed. Said once, with the way to see the real code, when what was printed looks like a failure.
 */
export function maskedNote(command: string, code: number | null, output: string): string {
  if (code !== 0 || !FILTERS.test(command.trimEnd()) || /pipefail/.test(command) || !FAILED.test(output)) return "";
  return '[exit 0 is the exit of the last program in the pipe, which hides a failure before it. Run again with "set -o pipefail; " first to get the real code]';
}
