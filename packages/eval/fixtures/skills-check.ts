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
  case "note-added": {
    const notes = parseEntries(readFileSync(".navvied/memory.md", "utf8"));
    ok = notes.length === 1 && notes[0]!.text.includes("zx-build-N") && notes[0]!.origin === "self";
    break;
  }
  case "forgotten": {
    const notes = parseEntries(readFileSync(".navvied/memory.md", "utf8"));
    ok = notes.length === 2 && notes.some((n) => n.id === "k1a002" && n.text === "Indent with tabs") && notes.some((n) => n.text.includes("beta.example.test")) && !notes.some((n) => n.text.includes("alpha.example.test"));
    break;
  }
  case "replaced": {
    const notes = parseEntries(readFileSync(".navvied/memory.md", "utf8"));
    ok = notes.length === 3 && notes.find((n) => n.id === "k3a002")?.text === "Run tests with bun test --timeout 30000" && notes.find((n) => n.id === "k3a001")?.text === "The api lives in src/api" && notes.find((n) => n.id === "k3a003")?.origin === "user";
    break;
  }
  case "created": {
    const text = skill ? readSkill(skill) : "";
    ok = !!skill && skill.description.length > 5 && text.includes("reports/weekly.md") && !text.includes("out/weekly.md") && /1\. Collect/.test(text) && /2\. Summarise/.test(text);
    break;
  }
  default: console.error("unknown check", what);
}
process.exit(ok ? 0 : 1);
