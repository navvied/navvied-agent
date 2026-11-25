import { createHash } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import type { ToolContext } from "../types.ts";

/** What a conversation has seen of one file the last time it read or wrote it whole. */
export interface Seen { hash: string; mtimeMs: number; size: number; /** The lines shown by the last read (1-based, `to` included) and the options of that read. */ from: number; to: number; key: string }

export const hashOf = (bytes: Uint8Array): string => createHash("sha1").update(bytes).digest("hex");

/** The hash of a file of any size, read in pieces. */
export async function hashFile(path: string): Promise<string> {
  const h = createHash("sha1");
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest("hex");
}

/**
 * The files a conversation has read or written, by path: the write tools refuse to change a file the model has never read, and a file
 * that changed since it was read, because their edit would rest on text the model no longer has.
 */
export class FileState {
  readonly #seen = new Map<string, Seen>();

  saw(path: string, seen: Seen): void { this.#seen.set(path, seen); }
  get(path: string): Seen | undefined { return this.#seen.get(path); }
  /** The conversation no longer holds what it was shown (it was summarised): a read is answered in full again, but the files stay known. */
  forgetShown(): void { for (const s of this.#seen.values()) s.key = ""; }
}

/** The corrective message for a write tool that needs the file read first. It carries the call to make. */
export const readFirst = (path: string, why: string): string => `Error: ${why} Read it first: Read {"file_path": ${JSON.stringify(path)}}, then send this call again.`;

/**
 * Whether a change to an existing file rests on what the model has seen: `ok`, `stale` (read before, changed since: only an exact,
 * unambiguous edit may go on), or a message to give the model.
 */
export function check(files: FileState | undefined, path: string, bytes: Uint8Array, unread = `${path} was not read in this conversation.`): "ok" | "stale" | string {
  if (!files) return "ok";
  const seen = files.get(path);
  if (!seen) return readFirst(path, unread);
  return seen.hash === hashOf(bytes) ? "ok" : "stale";
}

export const changedSince = (path: string): string => readFirst(path, `${path} changed after you read it (something else wrote to it).`);

/** Records what a conversation now knows of a file it has just written, so that its next change needs no new read. */
export function wrote(ctx: ToolContext, path: string, bytes: Uint8Array): void {
  const st = statSync(path);
  ctx.files?.saw(path, { hash: hashOf(bytes), mtimeMs: st.mtimeMs, size: st.size, from: 1, to: 0, key: "" });
}
