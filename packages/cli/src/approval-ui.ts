import { splitCommand } from "@navvied/engine";
import type { EngineEvent } from "@navvied/protocol";
import { diffLines } from "./diff-view.ts";
import type { Choice, IO } from "./io.ts";
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

/** The command of a Bash request, or nothing for any other tool. */
function bashCommand(asked: Asked): string | undefined {
  if (asked?.name !== "Bash") return undefined;
  const a = (typeof asked.input === "object" && asked.input !== null ? asked.input : {}) as Record<string, unknown>;
  return typeof a.command === "string" ? a.command : undefined;
}

/** The front of a command part, to remember as a pattern: the first word or two, as written, and a wildcard for the rest. */
function patternOf(part: string): string {
  const words = part.trim().split(/\s+/).filter(Boolean);
  return words.length >= 2 ? `${words[0]} ${words[1]} *` : words.length === 1 ? `${words[0]} *` : "*";
}

/** One pattern to offer "remember" for per part of the command, in the order they run, each at most once. */
function patternsOf(command: string): string[] { return [...new Set(splitCommand(command).map(patternOf))].slice(0, 3); }

/** What the person answered: the choice, for "change the command first" the command they typed, and for "remember as a pattern" the pattern to save. */
export interface Answer { optionId: string; input?: string; pattern?: string }

type Row = { choice: Choice } & ({ option: Approval["options"][number] } | { pattern: string });

export function screenRequest(screen: NonNullable<Approval["screen"]>): { title: string; body: string; labels: { once: string; always?: string; no: string } } {
  const app = screen.app;
  if (screen.about === "foreground") return { title: `Let navvied bring ${app} to the front?`, body: `${app} is hidden. To work in it, navvied has to show it on top of what you are doing.`, labels: { once: "Allow once", no: "Do not allow" } };
  if (screen.about === "input") return { title: `Let navvied type and click in ${app}?`, body: `It will use the keyboard and the mouse in ${app} only.`, labels: { once: "Allow for this task", always: `Always allow ${app}`, no: "Do not allow" } };
  return { title: `Let navvied use ${app}?`, body: `It wants to look at the window of ${app}.`, labels: { once: "Allow for this task", always: `Always allow ${app}`, no: "Do not allow" } };
}

async function askScreen(io: IO, e: Approval & { screen: NonNullable<Approval["screen"]> }, deny: Answer): Promise<Answer> {
  const words = screenRequest(e.screen);
  const rows = e.options.map((o) => ({ option: o, label: o.kind === "reject_once" || o.kind === "reject_always" ? words.labels.no : o.kind === "allow_always" ? (words.labels.always ?? words.labels.once) : words.labels.once }));
  const answer = await io.choose?.(words.title, rows.map((r) => ({ label: r.label })), 0, { heading: [paint(io.color, "cyan", paint(io.color, "bold", "Computer Use")), words.body] });
  const picked = typeof answer === "number" ? rows[answer] : undefined;
  return picked ? { optionId: picked.option.optionId } : deny;
}

/** Asks the person, with arrow keys, whether the agent may go ahead. Escape, or any way out, means no. A command can be changed first, where there is a way to type.
 * For a plain command (nothing that cannot be undone), a pattern taken from its own start can be remembered for next time, one row per part of a combined command. */
export async function askApproval(io: IO, e: Approval, asked: Asked, cwd: string, width: number): Promise<Answer> {
  const deny = { optionId: e.options.find((o) => o.kind === "reject_once" || o.kind === "reject_always")?.optionId ?? "deny" };
  if (!io.choose) return deny;
  if (e.screen) return askScreen(io, e as Approval & { screen: NonNullable<Approval["screen"]> }, deny);
  const request = describeRequest(asked, e.title, cwd, io.color, width);
  const shown = e.options.filter((o) => !o.editable || io.text);
  const heading = [paint(io.color, "cyan", paint(io.color, "bold", request.heading)), ...request.lines];
  const once = shown.find((o) => o.kind === "allow_once" && !o.editable);
  const command = bashCommand(asked);
  const patterns = once && command && e.risk === undefined ? patternsOf(command) : [];
  const rows: Row[] = [];
  for (const o of shown) {
    rows.push({ choice: o.editable ? { label: "Change the command first", hint: "Edit it, then it runs." } : label(o), option: o });
    if (o === once) for (const p of patterns) rows.push({ choice: { label: `Yes, and allow "${p}" from now on`, hint: "Every time, in every navvied session." }, pattern: p });
  }
  for (;;) {
    const answer = await io.choose("Allow this?", rows.map((r) => r.choice), 0, { heading, ...(e.risk ? { notice: [e.risk] } : {}) });
    const picked = typeof answer === "number" ? rows[answer] : undefined;
    if (!picked) return deny;
    if ("pattern" in picked) return { optionId: once!.optionId, pattern: picked.pattern };
    if (picked.option.kind === "reject_once" || picked.option.kind === "reject_always") {
      if (!io.text) return { optionId: picked.option.optionId };
      const said = await io.text("Tell it what to do instead, or leave this empty to just say no", "", { heading });
      if (said === "back") continue; // back to the list
      return { optionId: picked.option.optionId, ...(typeof said === "string" && said.trim() ? { input: said.trim() } : {}) };
    }
    if (!picked.option.editable) return { optionId: picked.option.optionId };
    const typed = await io.text!("Change the command", picked.option.editable.value, { heading });
    if (typeof typed === "string" && typed.trim()) return { optionId: picked.option.optionId, input: typed.trim() };
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
