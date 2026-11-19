import type { ApprovalChange } from "@navvied/protocol";

const MAX = 20_000;
const text = (v: unknown): string => (typeof v === "string" ? v : "");
const cut = (v: unknown): { text: string; cut: boolean } => { const t = text(v); return t.length > MAX ? { text: t.slice(0, MAX), cut: true } : { text: t, cut: false }; };

/** What an action would change, for the page to show beside the question. Tools that change nothing a person could read have none. */
export function approvalChange(tool: string, args: Record<string, unknown>): ApprovalChange | undefined {
  if (tool === "Edit") {
    const old = cut(args.old_string), next = cut(args.new_string);
    return { tool, file: text(args.file_path), old: old.text, new: next.text, ...(old.cut || next.cut ? { truncated: true as const } : {}) };
  }
  if (tool === "Write") {
    const content = cut(args.content);
    return { tool, file: text(args.file_path), content: content.text, ...(content.cut ? { truncated: true as const } : {}) };
  }
  if (tool === "Bash") {
    const command = cut(args.command);
    return { tool, command: command.text, ...(command.cut ? { truncated: true as const } : {}) };
  }
  return undefined;
}
