import type { ModelEntry } from "./config.ts";
import { readNote } from "./llama-server.ts";
import { join } from "node:path";

/** Where the note of the model server that this computer runs is kept. */
export const serverNote = (local: string): string => join(local, "server.json");

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; } };

/**
 * The entry of the configuration a model of this computer stands for right now: the address is the one the server listens on this time (it is a different port at each start, so
 * it is not kept in the configuration), and a model whose server is not running is refused in words.
 */
export function expandLocalModel(local: string, m: ModelEntry): { entry: ModelEntry } | { error: string } {
  const note = readNote(serverNote(local));
  if (!note || !alive(note.pid)) return { error: `${m.display?.name ?? m.model ?? "This model"} is not running. Start it first.` };
  const { local: own, ...rest } = m;
  return { entry: { ...rest, baseUrl: `http://127.0.0.1:${note.port}/v1`, api: "chat", reasoning: "none", ...(own?.window ? { window: own.window } : {}) } };
}
