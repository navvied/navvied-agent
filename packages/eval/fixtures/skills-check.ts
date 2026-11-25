/** The checks of the offline skill and memory tasks: `bun skills-check.ts <what> [name]`, run in the workspace. They read the files the way the agent's own loaders do. */
import { loadSkills, parseEntries, readSkill } from "../../engine/src/index.ts";
import { SKILL_FOLDERS } from "../../cli/src/presets.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const [what, name] = process.argv.slice(2);
const project = SKILL_FOLDERS.map((f) => join(process.cwd(), ...f.split("/")));
const skills = loadSkills({ project });
const skill = skills.find((s) => s.name === name);
let ok = false;
switch (what) {
  case "listed": ok = !!skill && skill.modelInvocable && skill.description.startsWith("Prepare the label for a release. Use it whenever") && !skill.description.includes("\n"); break;
  case "notes": ok = parseEntries(readFileSync(".navvied/memory.md", "utf8")).length === 1; break;
  case "created": {
    const text = skill ? readSkill(skill) : "";
    ok = !!skill && skill.description.length > 5 && text.includes("reports/weekly.md") && !text.includes("out/weekly.md") && /1\. Collect/.test(text) && /2\. Summarise/.test(text);
    break;
  }
  default: console.error("unknown check", what);
}
process.exit(ok ? 0 : 1);
