import type { PermMode } from "@navvied/protocol";
import { onlyLooks } from "./risk.ts";
import { splitCommand } from "./rules.ts";
import { exitPlanMode } from "./tools/index.ts";
import type { Tool } from "./types.ts";

/**
 * The tools offered to the model in a mode. Plan mode does not rely on the model behaving: write-capable tools are simply
 * not offered, and a way to present the finished plan is added.
 */
export function toolsFor(mode: PermMode, all: readonly Tool[], situation: { small: boolean; userText: string; jobs: number; typable?: number; skills?: number; recall?: boolean } = { small: false, userText: "", jobs: 0 }): Tool[] {
  const offered = all.filter((t) => t.offeredWhen?.(situation) ?? true);
  return mode === "plan" ? [...offered.filter((t) => t.readOnly), exitPlanMode] : offered;
}

/** Tools that change files: what the "edits" mode lets through. */
const EDITS = new Set(["Write", "Edit", "NotebookEdit"]);
/** Plain file commands the "edits" mode lets through, inside the project. */
const FILE_COMMANDS = /^(mkdir|touch|mv|cp|rmdir|ln)$/;

/**
 * Whether a call must be asked about in a mode, before anything about risk or rules. `ask` asks for everything that is not a plain look;
 * `edits` also lets file edits and plain file commands through; `auto` and `bypass` ask for nothing here (risk is judged apart).
 */
export function needsApproval(mode: PermMode, tool: Tool, args: Record<string, unknown> = {}): boolean {
  if (tool.readOnly || mode === "auto" || mode === "bypass" || mode === "plan") return false;
  if (tool.name === "Bash" && typeof args.command === "string") {
    if (onlyLooks(args.command)) return false;
    if (mode === "edits" && splitCommand(args.command).every((p) => FILE_COMMANDS.test(p.trim().split(/\s+/)[0] ?? ""))) return false;
    return true;
  }
  if (mode === "edits" && EDITS.has(tool.name)) return false;
  return true;
}
