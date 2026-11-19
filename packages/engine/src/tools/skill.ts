import type { Tool } from "../types.ts";
import { readSkill } from "../skills.ts";
import { str } from "./util.ts";

export const skill: Tool = {
  name: "Skill",
  readOnly: true,
  offeredWhen: ({ skills }) => (skills ?? 0) > 0,
  description: "Load the written instructions of a skill, listed in the system prompt, when the task matches it. Then follow them.",
  parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  title: (a) => `Load the ${str(a.name)} skill`,
  async run(a, ctx) {
    const all = ctx.skills?.() ?? [];
    const found = all.find((s) => s.name === str(a.name).trim());
    if (!found) return `Error: there is no skill "${str(a.name)}".${all.length ? ` Skills: ${all.map((s) => s.name).join(", ")}.` : ""}`;
    try { return readSkill(found); } catch (e) { return `Error: could not read the skill: ${e instanceof Error ? e.message : String(e)}`; }
  },
};
