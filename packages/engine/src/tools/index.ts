import type { Tool } from "../types.ts";
import { agent } from "./agent.ts";
import { recallTool } from "./recall.ts";
import { bash, bashInput, bashOutput, killShell } from "./bash.ts";
import { browser } from "./browser.ts";
import { edit } from "./edit.ts";
import { glob } from "./glob.ts";
import { grep } from "./grep.ts";
import { read } from "./read.ts";
import { rememberTool } from "./remember.ts";
import { skill } from "./skill.ts";
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

export const defaultTools = (): Tool[] => [read, write, edit, bash, bashOutput, bashInput, killShell, glob, grep, webFetch, webSearch, browser, skill, agent, rememberTool, recallTool, todo];
export { recallTool, agent, bash, bashInput, bashOutput, browser, edit, killShell, glob, grep, read, rememberTool, skill, todo, webFetch, webSearch, write };
