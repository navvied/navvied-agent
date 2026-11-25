import type { Tool } from "../types.ts";
import { agent } from "./agent.ts";
import { ask } from "./ask.ts";
import { recallTool } from "./recall.ts";
import { bash, bashInput, bashOutput, killShell } from "./bash.ts";
import { browser } from "./browser.ts";
import { applyPatchTool, type PatchMode } from "./apply-patch.ts";
import { edit } from "./edit.ts";
import { executeCode } from "./execute-code.ts";
import { glob } from "./glob.ts";
import { grep } from "./grep.ts";
import { multiEdit } from "./multi-edit.ts";
import { notebookEdit } from "./notebook.ts";
import { lookAt, watch } from "./look.ts";
import { makeImage, makeVideo } from "./make-media.ts";
import { read } from "./read.ts";
import { rememberTool } from "./remember.ts";
import { schedule } from "./schedule.ts";
import { skill } from "./skill.ts";
import { speak, transcribe } from "./speech.ts";
import { skillManage } from "./skill-manage.ts";
import { todo } from "./todo.ts";
import { webFetch } from "./web-fetch.ts";
import { webSearch } from "./web-search.ts";
import { write } from "./write.ts";

/** Plan mode only: the way the model hands in a finished plan. Handled by the engine itself, not run. */
export const PLAN_TOOL_NAME = "ExitPlanMode";
export const exitPlanMode: Tool = {
  name: PLAN_TOOL_NAME,
  readOnly: true,
  description: "Plan mode only: present the finished plan to the user for approval. Call it once you know exactly what to do.",
  parameters: { type: "object", properties: { plan: { type: "string", description: "The step-by-step plan, in markdown." } }, required: ["plan"] },
  title: () => "Present plan",
  async run() { return "Plan presented."; },
};

export const defaultTools = (o: { applyPatch?: PatchMode | undefined } = {}): Tool[] => [read, write, edit, multiEdit, notebookEdit, ...(o.applyPatch === "off" ? [] : [applyPatchTool(o.applyPatch ?? "auto")]), bash, bashOutput, bashInput, killShell, glob, grep, webFetch, webSearch, browser, skill, agent, rememberTool, recallTool, skillManage, todo, ask, executeCode, schedule, lookAt, watch, transcribe, speak, makeImage, makeVideo];
export { lookAt, makeImage, makeVideo, speak, transcribe, watch, schedule, executeCode, recallTool, skillManage, agent, ask, bash, bashInput, bashOutput, browser, edit, multiEdit, notebookEdit, killShell, glob, grep, read, rememberTool, skill, todo, webFetch, webSearch, write };
