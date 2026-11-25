import type { PermMode } from "@navvied/protocol";
import { onlyLooks } from "./risk.ts";
import { programName, shellView } from "./shell-scan.ts";
import { FILE_WRITERS } from "./tools/changed.ts";
import { exitPlanMode } from "./tools/index.ts";
import type { Tool } from "./types.ts";

/** What the situation of a conversation says about which tools are worth their place in the list. */
export type Situation = Parameters<NonNullable<Tool["offeredWhen"]>>[0];

/** The tools the situation brings in, in any mode. */
export const offeredIn = (all: readonly Tool[], situation: Situation): Tool[] => all.filter((t) => t.offeredWhen?.(situation) ?? true);

/**
 * What a mode lets through of tools already offered. Plan mode does not rely on the model behaving: write-capable tools are simply
 * not offered, and a way to present the finished plan is added.
 */
export const inMode = (mode: PermMode, offered: readonly Tool[]): Tool[] => (mode === "plan" ? [...offered.filter((t) => t.readOnly || t.inPlan), exitPlanMode] : [...offered]);

/** The tools offered to the model in a mode. */
export const toolsFor = (mode: PermMode, all: readonly Tool[], situation: Situation = { small: false, userText: "", jobs: 0 }): Tool[] => inMode(mode, offeredIn(all, situation));

/** Tools that change files: what the "edits" mode lets through. */
const EDITS = FILE_WRITERS;
/** Plain file commands the "edits" mode lets through, inside the project. */
const FILE_COMMANDS = /^(mkdir|touch|mv|cp|rmdir|ln)$/;

/**
 * Whether a call must be asked about in a mode, before anything about risk or rules. `ask` asks for everything that is not a plain look;
 * `edits` also lets file edits and plain file commands through; `auto` and `bypass` ask for nothing here (risk is judged apart).
 */
export function needsApproval(mode: PermMode, tool: Pick<Tool, "name" | "readOnly">, args: Record<string, unknown> = {}): boolean {
  if (tool.name === "Remember" && args.action === "list") return false;
  if (tool.readOnly || mode === "auto" || mode === "bypass" || mode === "plan") return false;
  if (tool.name === "Schedule" && (args.action === undefined || args.action === "list" || args.action === "runs")) return false;
  if (tool.name === "Bash" && typeof args.command === "string") {
    if (onlyLooks(args.command)) return false;
    if (mode === "edits") { const view = shellView(args.command); if (view.cmds.length && !view.found.length && view.cmds.every((c) => !c.sudo && FILE_COMMANDS.test(programName(c.words[0] ?? "")))) return false; }
    return true;
  }
  if (mode === "edits" && EDITS.has(tool.name)) return false;
  return true;
}
