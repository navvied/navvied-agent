import type { EngineEvent } from "@navvied/protocol";
import { diffLines } from "./diff-view.ts";
import type { IO } from "./io.ts";
import { paint } from "./render.ts";
import { diffRows, shortPath } from "./steps.ts";

type Approval = Extract<EngineEvent, { ev: "approval" }>;
type Asked = { name: string; input: unknown } | undefined;

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** What the agent wants to do, as a title and the lines that show it: the command, or the change itself. */
export function describeRequest(asked: Asked, title: string, cwd: string, color: boolean, width: number): { heading: string; lines: string[] } {
  const a = (typeof asked?.input === "object" && asked.input !== null ? asked.input : {}) as Record<string, unknown>;
  switch (asked?.name) {
    case "Bash": return { heading: "It wants to run a command", lines: [`${paint(color, "dim", "$")} ${str(a.command).replace(/\s+/g, " ").slice(0, 300)}`] };
    case "Edit": return { heading: "It wants to change a file", lines: [shortPath(str(a.file_path), cwd), "", ...diffLines(diffRows(str(a.old_string), str(a.new_string), 1, 10), color, width, 2)] };
    case "Write": return { heading: "It wants to write a file", lines: [shortPath(str(a.file_path), cwd)] };
    case "WebFetch": return { heading: "It wants to open a web page", lines: [str(a.url)] };
    default: return { heading: asked ? `It wants to use ${asked.name}` : "It wants your permission", lines: [title] };
  }
}

const label = (option: Approval["options"][number]): { label: string; hint?: string } =>
  option.kind === "allow_always" ? { label: option.name.replace(/^Allow, and /, "Yes, and "), hint: "Until you close navvied." }
  : option.kind === "reject_once" || option.kind === "reject_always" ? { label: "No, I will tell it what to do instead" }
  : { label: "Yes" };

/** What the person answered: the choice, and for "change the command first" the command they typed. */
export interface Answer { optionId: string; input?: string }

/** Asks the person, with arrow keys, whether the agent may go ahead. Escape, or any way out, means no. A command can be changed first, where there is a way to type. */
export async function askApproval(io: IO, e: Approval, asked: Asked, cwd: string, width: number): Promise<Answer> {
  const deny = { optionId: e.options.find((o) => o.kind === "reject_once" || o.kind === "reject_always")?.optionId ?? "deny" };
  if (!io.choose) return deny;
  const request = describeRequest(asked, e.title, cwd, io.color, width);
  const shown = e.options.filter((o) => !o.editable || io.text);
  const heading = [paint(io.color, "cyan", paint(io.color, "bold", request.heading)), ...request.lines];
  for (;;) {
    const answer = await io.choose("Allow this?", shown.map((o) => (o.editable ? { label: "Change the command first", hint: "Edit it, then it runs." } : label(o))), 0, { heading });
    const picked = typeof answer === "number" ? shown[answer] : undefined;
    if (!picked) return deny;
    if (!picked.editable) return { optionId: picked.optionId };
    const typed = await io.text!("Change the command", picked.editable.value, { heading });
    if (typeof typed === "string" && typed.trim()) return { optionId: picked.optionId, input: typed.trim() };
    // Backed out of the edit: ask again.
  }
}

/** The question asked when a plan is ready. Resolves to what the person chose. */
export async function askPlan(io: IO): Promise<"build" | "change" | "keep"> {
  if (!io.choose) return "keep";
  const answer = await io.choose(
    "Ready to start?",
    [{ label: "Yes, start building", hint: "Switches to Auto and follows the plan." }, { label: "Change the plan", hint: "Tell it what to do differently." }, { label: "No, keep it as a plan" }],
    0,
    { heading: [paint(io.color, "cyan", paint(io.color, "bold", "The plan is ready")), "Nothing has been changed yet."] },
  );
  return answer === 0 ? "build" : answer === 1 ? "change" : "keep";
}
