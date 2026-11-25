import type { EngineEvent, ToolCategory, ToolEntry } from "@navvied/protocol";
import type { Kit } from "./providers/kit.ts";

type Tools = Extract<EngineEvent, { ev: "tools" }>;

/** What a person is told before a tool that coding is made of is switched off (the same line as the page). */
export const CORE_WARNING = "Without it the agent can do much less.";
const NOTE: Partial<Record<ToolEntry["state"], string>> = { "needs-setup": "Needs setup", soon: "Soon", "unavailable-here": "Not on this computer", experimental: "Experimental" };

/** Whether a tool has a switch of its own to press: one that waits for setup, is not built yet or cannot run here, has not. */
const switchable = (e: ToolEntry): boolean => e.state !== "needs-setup" && e.state !== "soon" && e.state !== "unavailable-here";
const isOn = (e: ToolEntry): boolean => switchable(e) && e.on;
const inCategory = (t: Tools, c: ToolCategory): ToolEntry[] => t.entries.filter((e) => e.category === c.id);
/** A tool is a core one when the engine says any tool it stands for is (reading, writing, searching files, running commands). */
const isCore = (t: Tools, e: ToolEntry): boolean => e.names.some((n) => t.items.find((i) => i.name === n)?.core);

/** `/tools`: the categories, each with its tools, and for each one its own switch. Enter switches it where it stands, or starts its setup; Esc goes back. */
export async function toolsScreen(k: Kit): Promise<void> {
  let state = await k.link.call("tools", { cmd: "tools" });
  let at = 0;
  for (;;) {
    if (typeof state === "string") { k.say(state); return; }
    const t: Tools = state;
    const using = t.backends.find((b) => b.using) ?? t.backends[0];
    const rows = [
      ...t.categories.map((c) => { const mine = inCategory(t, c); return { label: c.title, hint: `${mine.filter(isOn).length} of ${mine.length} on: ${mine.map((e) => e.title).join(", ")}` }; }),
      { label: `Where commands run: ${using?.label ?? "This computer"}`, hint: "Choose this computer, a container, or another computer" },
    ];
    const picked = await k.choose("Tools", "What the agent can do here", rows, { at });
    if (picked === undefined) return;
    at = picked;
    const category = t.categories[picked];
    state = category ? await page(k, category, t) : await where(k, t);
  }
}

/** One category: every tool with its own switch, until the person goes back. Resolves to the newest report of the tools. */
async function page(k: Kit, c: ToolCategory, first: Tools): Promise<Tools | string> {
  let t: Tools = first;
  let at = 0;
  for (;;) {
    const mine = inCategory(t, c);
    const rows = mine.map((e) => ({ label: `${switchable(e) ? (e.on ? "on " : "off") : "   "}  ${e.title}${NOTE[e.state] ? `  ${NOTE[e.state]}` : ""}`, hint: e.about }));
    const picked = await k.choose(c.title, "Tools", rows, { at });
    if (picked === undefined) return t;
    at = picked;
    const e = mine[picked]!;
    if (!switchable(e)) { if (e.state === "needs-setup" && e.setup) k.link.send({ cmd: "tool.setup", id: e.id }); continue; }
    if (e.on && isCore(t, e) && !(await keepOff(k, e))) continue;
    const got = await k.link.call("tools", { cmd: "tool.toggle", name: e.id, enabled: !e.on });
    if (typeof got === "string") { k.note.push(got); continue; }
    t = got;
  }
}

/** Asks before a core tool is switched off. Keeping it on is the first row, so a press is needed to turn it off. */
async function keepOff(k: Kit, e: ToolEntry): Promise<boolean> {
  return (await k.choose(`Turn off ${e.title}?`, `Turn off ${e.title}?`, [{ label: "Keep it on", hint: CORE_WARNING }, { label: "Turn it off" }])) === 1;
}

/** Where the Bash tool runs commands. */
async function where(k: Kit, t: Tools): Promise<Tools | string> {
  const picked = await k.choose("Where should commands run?", "Where should commands run?", t.backends.map((b) => ({ label: `${b.using ? "● " : "  "}${b.label}${b.ready ? "" : "  (needs setup)"}`, hint: b.hint ?? b.about })), { body: ["Only commands move; files are still read and written here."] });
  const b = picked === undefined ? undefined : t.backends[picked];
  if (!b) return t;
  if (!b.ready) { k.note.push(b.hint ?? "That place is not available."); return t; }
  const got = await k.link.call("tools", { cmd: "terminal.use", backend: b.id });
  if (typeof got === "string") { k.note.push(got); return t; }
  k.note.push(`Commands will run on ${b.label.toLowerCase()} (from the next new conversation).`);
  return got;
}
