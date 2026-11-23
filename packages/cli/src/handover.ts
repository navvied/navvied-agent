import type { HistoryItem, ModelInfo } from "@navvied/protocol";
import type { ConfigFile } from "./config.ts";
import { modelInfoOf, resolved } from "./create.ts";

/** What the person is told when a conversation goes on with a model that another engine runs. */
export const handedOver = (name: string): string => `Now using ${name}. The conversation so far goes with it.`;

/**
 * The models that can only be reached by handing the conversation over: when a program runs it, the ones navvied runs itself, and when navvied
 * runs it, the programs. Listed beside the engine's own, so a page offers every choice in one list. A chat has no programs to offer.
 */
export function otherKind(file: ConfigFile | null, programNow: boolean, chat: boolean): ModelInfo[] {
  if (!programNow && chat) return [];
  return Object.entries(file?.models ?? {}).filter(([, e]) => (e.command !== undefined) !== programNow).map(([id, e]) => ({ ...modelInfoOf(id, e), handover: true as const }));
}

/** Whether a conversation may go on with this model: said before anything is closed, so a refusal leaves the engine as it was. */
export function checkTarget(file: ConfigFile | null, env: Record<string, string | undefined>, path: string, id: string, chat: boolean): { ok: true; program: boolean } | { ok: false; error: string } {
  const entry = file?.models[id];
  if (!entry) return { ok: false, error: `There is no model "${id}".` };
  if (entry.display?.locked) return { ok: false, error: `${entry.display.name ?? id} is not available yet.` };
  const model = resolved(id, file, env, path);
  if (!model.ok) return { ok: false, error: model.error };
  if (chat && model.value.cli) return { ok: false, error: "A chat needs a model that navvied runs itself, not one reached through another program." };
  return { ok: true, program: !!model.value.cli };
}

/** The conversation as text for a model that was not there, newest last, cut from the front when it is long. Told to the program as part of its instructions, never shown. */
export function transcriptOf(items: readonly HistoryItem[], most = 30_000): string {
  const lines = items.map((i) => (i.k === "tool" ? `(a tool was used: ${i.text})` : `${i.k === "user" ? "The person" : "You"}: ${i.text}`));
  let text = lines.join("\n");
  if (text.length > most) text = `[earlier messages left out]\n${text.slice(-most)}`;
  return `This conversation was held with another model before you. What was said so far, oldest first; carry on from it as one who was there:\n\n${text}`;
}
