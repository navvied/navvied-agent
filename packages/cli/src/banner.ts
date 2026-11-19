import type { PermMode } from "@navvied/protocol";
import { paint } from "./render.ts";
import { currentTheme, fg, mix } from "./theme.ts";

export const MODE_LABEL: Record<PermMode, string> = { auto: "Auto", ask: "Ask first", edits: "Accept edits", plan: "Plan only", bypass: "Bypass permissions" };
const MODE_SHORT: Record<PermMode, string> = { ask: "Ask", edits: "Edits", plan: "Plan", auto: "Auto", bypass: "Bypass" };
const MODE_NOTE: Record<PermMode, string> = {
  auto: "asks only for what cannot be undone",
  ask: "asks before changing files or running commands",
  edits: "changes files without asking, asks before running other commands",
  plan: "reads and plans, and changes nothing until you approve",
  bypass: "asks nothing at all (use it in a sandbox)",
};

const AMBER = "#e8ad3c";
const BLUE = "#40aef2";

export interface BannerInfo {
  version: string;
  cwd: string;
  mode: PermMode;
  /** The modes this model can work in; the hint about switching lists these. */
  modes?: readonly PermMode[];
  /** Absent when no model is connected yet. */
  model?: { name: string; where: string };
  /** Instruction files in effect. */
  rules?: readonly string[];
  home?: string;
  /** A chat: a conversation with a folder of its own, not a project. */
  chat?: boolean;
}

const GLYPHS: Record<string, string[]> = {
  N: ["█   █", "██  █", "█ █ █", "█  ██", "█   █"],
  A: [" ███ ", "█   █", "█████", "█   █", "█   █"],
  V: ["█   █", "█   █", "█   █", " █ █ ", "  █  "],
  I: ["███", " █ ", " █ ", " █ ", "███"],
  E: ["█████", "█    ", "████ ", "█    ", "█████"],
  D: ["████ ", "█   █", "█   █", "█   █", "████ "],
};
const ROW_BLEND = [0.5, 0.25, 0, -0.2, -0.4];

/** The name in large letters, lit from the top in the theme's accent colour. Used on the first-run welcome. */
export const wordmark = (color: boolean): string[] =>
  [0, 1, 2, 3, 4].map((row) => {
    const line = [..."NAVVIED"].map((ch) => GLYPHS[ch]![row]!).join("  ");
    if (!color) return line;
    const t = currentTheme(), blend = ROW_BLEND[row]!;
    return `${fg(blend >= 0 ? mix(t.accent, "#ffffff", blend) : mix(t.accent, "#000000", -blend), t.truecolor)}${line}\u001b[0m`;
  });

/** The brand mark: two hexagons, amber and blue, the split crystal of the navvied logo. */
export const mark = (color: boolean): string => {
  if (!color) return "⬢⬢";
  const t = currentTheme();
  return `${fg(AMBER, t.truecolor)}⬢${fg(BLUE, t.truecolor)}⬢\u001b[0m`;
};

const visible = (s: string): number => [...s.replace(/\u001b\[[0-9;]*m/g, "")].length;

const wrap = (text: string, width: number): string[] => {
  const lines: string[] = [];
  let line = "";
  for (const w of text.split(" ")) {
    if (line && line.length + 1 + w.length > width) { lines.push(line); line = w; } else line = line ? `${line} ${w}` : w;
  }
  return line ? [...lines, line] : lines;
};

const tidy = (cwd: string, home: string | undefined, width: number): string => {
  const short = home && (cwd === home || cwd.startsWith(`${home}/`)) ? `~${cwd.slice(home.length)}` : cwd;
  return short.length > width ? `…${short.slice(short.length - width + 1)}` : short;
};

export interface Keys { key: string; does: string }

/** Key and meaning rows, aligned. */
export function keyRows(rows: Keys[], color: boolean): string[] {
  const w = Math.max(...rows.map((r) => r.key.length)) + 3;
  return rows.map((r) => `  ${paint(color, "cyan", paint(color, "bold", r.key.padEnd(w)))}${paint(color, "dim", r.does)}`);
}

/**
 * The welcome screen. It says what this is, what is connected and what to do next; it is shown at the start of a
 * session and scrolls away once the conversation begins.
 */
export function renderBanner(info: BannerInfo, color: boolean, columns = 100): string {
  const width = Math.min(Math.max(columns, 60), 110);
  const dim = (s: string): string => paint(color, "dim", s);
  const bold = (s: string): string => paint(color, "bold", s);
  const accent = (s: string): string => paint(color, "cyan", s);
  const title = `  ${mark(color)}  ${accent(bold("navvied"))}`;
  const version = paint(color, "faint", `v${info.version}`);
  const gap = Math.max(1, Math.max(columns, 60) - 1 - visible(title) - visible(version));
  const modes = info.modes ?? (["ask", "edits", "plan", "auto", "bypass"] as const);
  const intro = wrap(info.chat ? "Your assistant. Ask anything. It can search the web and make files for you, in a folder of its own." : "Your coding assistant. Describe what to build or fix, and it does the work in this folder.", width - 7).map((l) => `     ${dim(l)}`);
  const lines: string[] = ["", `${title}${" ".repeat(gap)}${version}`, ...intro, ""];

  if (!info.model) {
    lines.push(`  ${paint(color, "yellow", "●")} ${bold("No model connected yet")}`);
    lines.push(...wrap("A model is the AI that does the thinking. Choose one to get started.", width - 6).map((l) => `    ${dim(l)}`));
    lines.push("", `  ${bold("Get started")}`);
    const step = (n: string, parts: [string, boolean][]): string => `  ${accent(n)}  ${parts.map(([t, hot]) => (hot ? accent(bold(t)) : dim(t))).join("")}`;
    lines.push(step("1", [["Press ", false], ["Enter", true], [" to see how to connect one.", false]]));
    lines.push(step("2", [["Use ", false], ["↑ ↓", true], [" to choose, and ", false], ["Enter", true], [" to confirm. Nothing to type.", false]]));
    lines.push(step("3", [["Then just describe what you want done.", false]]));
    lines.push("", `  ${paint(color, "faint", "Nothing to install: the free models of navvied.com (no account, pick them in the list),")}`);
    lines.push(`  ${paint(color, "faint", "or sign in with a free navvied account for more.")}`);
    lines.push(`  ${paint(color, "faint", "Free and private: a model running on this computer (Ollama, LM Studio).")}`);
    lines.push(`  ${paint(color, "faint", "Subscription: a program you are signed in to.   Pay per use: an API key.")}`, "");
    return lines.join("\n");
  }

  const field = (name: string, value: string, note = ""): string => `  ${dim(name.padEnd(9))}${value}${note ? `  ${dim(note)}` : ""}`;
  lines.push(field("Model", info.model.name, info.model.where));
  lines.push(field(info.chat ? "Files" : "Folder", tidy(info.cwd, info.home, width - 12), info.chat ? "what it makes for you is kept here" : ""));
  if (!info.chat) lines.push(field("Mode", MODE_LABEL[info.mode], MODE_NOTE[info.mode]));
  if (info.rules?.length) lines.push(field("Rules", info.rules.join(", "), "your project instructions"));
  lines.push("", `  ${bold("Try it")}`, `  ${paint(color, "faint", "Type a request in plain words, for example:")}`);
  lines.push(...(info.chat ? [`    ${dim('"plan a week in Bali for two"')}`, `    ${dim('"explain compound interest, then make a table I can keep"')}`] : [`    ${dim('"add a contact page to the website"')}`, `    ${dim('"why does the build fail?"')}`]), "", `  ${bold("Handy keys")}`);
  lines.push(...keyRows([
    { key: "/", does: "Show every command" },
    { key: "@", does: "Attach a file to your message" },
    ...(modes.length > 1 ? [{ key: "Shift+Tab", does: `Switch mode: ${modes.map((m) => MODE_SHORT[m]).join(", ")}` }] : []),
    { key: "Esc", does: "Stop what it is doing" },
  ], color), "");
  return lines.join("\n");
}
