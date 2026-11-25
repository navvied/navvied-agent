import type { Tool } from "../types.ts";
import { modelSkills, readSkill } from "../skills.ts";
import { str } from "./util.ts";

const plain = (s: string): string => s.trim().replace(/^\/+/, "").toLowerCase().replace(/[\s_]+/g, "-");

export const skill: Tool = {
  name: "Skill",
  readOnly: true,
  offeredWhen: ({ skills }) => (skills ?? 0) > 0,
  description: "Load the written instructions of a skill listed in the system prompt when the task matches it, then follow them.",
  parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  fixArgs: (a) => ({ ...a, name: a.name ?? a.skill ?? a.skill_name ?? a.id }),
  title: (a) => `Load the ${str(a.name)} skill`,
  async run(a, ctx) {
    const all = modelSkills(ctx.skills?.() ?? []);
    const want = plain(str(a.name));
    const found = all.find((s) => s.name === want) ?? all.find((s) => s.name.startsWith(want) && want.length >= 3);
    if (!found) return `Error: there is no skill "${str(a.name)}".${all.length ? ` Skills: ${all.map((s) => s.name).join(", ")}.` : ""}`;
    try { return readSkill(found); } catch (e) { return `Error: could not read the skill: ${e instanceof Error ? e.message : String(e)}`; }
  },
};
