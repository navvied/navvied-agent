import type { ComputerCall } from "../types.ts";

const MOST_LINES = 8;
const MOST_CHARS = 200;
const cut = (s: string): string => (s.length > MOST_CHARS ? `${s.slice(0, MOST_CHARS - 1)}…` : s);

/** What a step is about to do, as the lines of a consent: the action as the model wrote it, and for typing the text itself, a line each. Data for a screen to lay out; no wording of ours. */
export function askLines(c: ComputerCall): string[] {
  const at = c.x !== undefined && c.y !== undefined ? `at ${c.x},${c.y}` : undefined;
  const held = c.keys && c.action !== "key" ? ` holding ${c.keys}` : "";
  const first =
    c.action === "capture" ? `capture${c.app ? ` ${c.app}` : ""}${c.mode ? ` (${c.mode})` : ""}` :
    c.action === "click" ? `${c.count === 2 ? "double click" : `${c.button ? `${c.button} ` : ""}click`} ${c.target ?? at ?? ""}${held}` :
    c.action === "type" ? "type" :
    c.action === "key" ? `key ${c.keys ?? ""}` :
    c.action === "scroll" ? `scroll ${c.direction ?? "down"} ${c.amount ?? ""}${held}` :
    c.action === "drag" ? `drag ${c.target ?? at ?? ""} to ${c.to ?? (c.to_x !== undefined ? `${c.to_x},${c.to_y}` : "")}${held}` :
    c.action;
  const text = c.action === "type" && c.text ? c.text.split(/\r?\n/) : [];
  return [first, ...text].map((l) => cut(l.replace(/\s+$/g, "").replace(/ {2,}/g, " ").trim())).slice(0, MOST_LINES);
}
