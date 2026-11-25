import { keep, noteItems, type MemoryPaths } from "@navvied/engine";
import type { EngineEvent, MemoryExtract, Result } from "@navvied/protocol";
import { loadConfig, saveMemoryExtract, type Env } from "./config.ts";
import { notice } from "./review.ts";

type Event<T extends EngineEvent["ev"]> = Extract<EngineEvent, { ev: T }>;

export const memoryNotes = (paths: MemoryPaths, scope?: "project" | "user"): Event<"memory.notes"> => ({ ev: "memory.notes", items: noteItems(paths, scope) });

/** Changes or forgets one note by its id, through the same checks the Remember tool is held to; then the list as it is now. */
export function changeNote(paths: MemoryPaths, change: { id: string; scope: "project" | "user"; text?: string }, today: string): EngineEvent[] {
  // `keep` also finds a note by some of its words: a page names one by its id only, so an id that is gone is not another note.
  if (!noteItems(paths, change.scope).some((n) => n.id === change.id)) return [{ ev: "error", msg: "That note is gone." }, memoryNotes(paths)];
  const said = keep(paths, change.text === undefined ? { action: "forget", scope: change.scope, target: change.id } : { action: "replace", scope: change.scope, target: change.id, text: change.text }, { today, origin: "user" });
  return [notice(said), memoryNotes(paths)];
}

/** How the agent looks through what the person said for lasting facts: read, or set first. */
export function extractSetting(file: string, env: Env, mode?: MemoryExtract): Result<Event<"memory.extract">> {
  if (mode) {
    const saved = saveMemoryExtract(file, mode);
    return saved.ok ? { ok: true, value: { ev: "memory.extract", mode } } : saved;
  }
  const read = loadConfig(file, env);
  return read.ok ? { ok: true, value: { ev: "memory.extract", mode: read.value?.memory?.extract ?? "rules" } } : read;
}
