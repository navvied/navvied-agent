import type { Effort, EngineEvent } from "@navvied/protocol";
import type { Choice } from "./io.ts";
import type { ConfigFile } from "./config.ts";
import { describeEntry } from "./create.ts";

type Caps = Extract<EngineEvent, { ev: "caps" }>;

/** What choosing a row does: change model inside this conversation, start a conversation with another program, or set one up. */
export type ModelAction = { kind: "current" } | { kind: "switch"; id: string; handover: boolean } | { kind: "restart"; name: string } | { kind: "connect" };

export interface ModelRow extends Choice { action: ModelAction }

/** The list a person picks from: the models of this conversation first, then the others they have connected, then a way to add one. */
export function modelRows(caps: Caps | undefined, currentName: string, file: ConfigFile | null): ModelRow[] {
  const rows: ModelRow[] = [];
  const listed = new Set<string>();
  for (const m of caps?.models ?? []) {
    listed.add(m.id);
    const hint = m.current ? "In use now." : m.locked ? "Not available yet." : m.blurb;
    rows.push({ label: m.name, ...(hint ? { hint } : {}), action: m.current ? { kind: "current" } : { kind: "switch", id: m.id, handover: m.handover === true } });
  }
  const entries = Object.entries(file?.models ?? {});
  if (!rows.length) {
    const own = file?.models[currentName];
    rows.push({ label: own?.model ?? currentName, hint: "In use now.", action: { kind: "current" } });
  }
  const inList = (name: string): boolean => listed.has(name) || name === currentName;
  for (const [name, e] of entries) {
    if (inList(name)) continue;
    rows.push({ label: e.model ?? name, hint: `${describeEntry(e)} Starts a new conversation.`, action: { kind: "restart", name } });
  }
  rows.push({ label: "Connect another model", hint: "Sign in to a service, or add one on this computer.", action: { kind: "connect" } });
  return rows;
}

const EFFORT_WORDS: Record<Effort, { label: string; hint: string }> = {
  minimal: { label: "Minimal", hint: "The least thinking. Quick answers." },
  low: { label: "Low", hint: "Fastest. Good for small questions." },
  medium: { label: "Medium", hint: "A balance. A good everyday choice." },
  high: { label: "High", hint: "Slower and more careful. Good for bugs." },
  xhigh: { label: "Very high", hint: "Slower still. For harder problems." },
  max: { label: "Maximum", hint: "Slowest. For the hardest problems." },
};

export const effortLabel = (level: Effort): string => EFFORT_WORDS[level].label;

/** The rows of the effort menu: Auto first, then each level the model has. */
export function effortRows(efforts: readonly Effort[]): { label: string; hint: string; level: Effort | "auto" }[] {
  return [{ label: "Auto", hint: "Let the model decide.", level: "auto" }, ...efforts.map((level) => ({ ...EFFORT_WORDS[level], level }))];
}
