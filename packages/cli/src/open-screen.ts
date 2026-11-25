import { basename, dirname } from "node:path";
import type { IO } from "./io.ts";
import type { SavedFile } from "./saved-files.ts";

/** `/open`: the files this conversation made (newest first); the one picked is opened, or its folder is shown. Esc goes back. */
export async function openScreen(io: IO, files: SavedFile[], say: (text: string) => void): Promise<void> {
  if (!files.length) { say("Nothing has been made in this conversation yet."); return; }
  const at = await io.choose?.("Open a file", files.map((f) => ({ label: basename(f.path), hint: `${f.path}, ${f.size}` })), 0);
  const file = typeof at === "number" ? files[at] : undefined;
  if (!file) return;
  const what = await io.choose?.(basename(file.path), [{ label: "Open", hint: "Opens it with this computer's own program." }, { label: "Show the folder" }], 0);
  if (what === 0) io.system.open(file.path);
  else if (what === 1) io.system.open(dirname(file.path));
}
