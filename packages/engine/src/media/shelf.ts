import { randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, type Stats } from "node:fs";
import { basename } from "node:path";
import type { MediaRef } from "@navvied/protocol";
import { pictureSize } from "../tools/picture-file.ts";

/** Most bytes of one file a page may fetch, how many files are kept at once, and the most one `read` gives. */
export const SHELF = { file: 64 * 1024 * 1024, count: 200, chunk: 256 * 1024 } as const;

/** What a tool says it made; the shelf checks the file itself and makes the reference. */
export interface MediaFile { path: string; mime: string; seconds?: number }

interface Held { ref: MediaRef; path: string; dev: number; ino: number; size: number; mtime: number }

const kindOf = (mime: string): MediaRef["kind"] | undefined => (mime.startsWith("image/") ? "image" : mime.startsWith("audio/") ? "audio" : mime.startsWith("video/") ? "video" : undefined);
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const mine = (st: Stats): boolean => typeof process.getuid !== "function" || st.uid === process.getuid();

/**
 * The files the engine itself made for the person to look at or listen to (a picture, a sound, a video), and how a page far away fetches them. A page names a file by the id this
 * gave and by nothing else, so it can never ask for another path. A file is held only when it is a plain file (no link) of this user and at most `SHELF.file` bytes, and it is read
 * only if it is still that same file: a file swapped for a link or for another file after it was kept is refused. Only the newest `SHELF.count` are kept.
 */
export class MediaShelf {
  #held = new Map<string, Held>();

  /** A reference for a file a tool made, or nothing when the file is not one of a kind a page can show or is not as described above. */
  keep(file: MediaFile): MediaRef | undefined {
    const kind = kindOf(file.mime);
    if (!kind) return undefined;
    try {
      const st = lstatSync(file.path);
      if (!st.isFile() || !mine(st) || st.size === 0 || st.size > SHELF.file) return undefined;
      let size: { width: number; height: number } | undefined;
      if (kind === "image") { const fd = openSync(file.path, constants.O_RDONLY | NOFOLLOW); try { const head = Buffer.alloc(Math.min(st.size, 65536)); readSync(fd, head, 0, head.length, 0); size = pictureSize(head); } finally { closeSync(fd); } }
      const id = randomBytes(12).toString("hex");
      const ref: MediaRef = { id, kind, mime: file.mime, bytes: st.size, name: basename(file.path), ...(size ?? {}), ...(file.seconds ? { seconds: file.seconds } : {}) };
      this.#held.set(id, { ref, path: file.path, dev: st.dev, ino: st.ino, size: st.size, mtime: st.mtimeMs });
      while (this.#held.size > SHELF.count) this.#held.delete(this.#held.keys().next().value!);
      return ref;
    } catch { return undefined; }
  }

  /** The bytes of a kept file from `offset`, at most `length` (and `SHELF.chunk`); or why not, in a few plain words. */
  read(id: string, offset = 0, length: number = SHELF.chunk): { ref: MediaRef; offset: number; data: Buffer; done: boolean } | { error: string } {
    const held = this.#held.get(id);
    if (!held) return { error: "That file is not there any more." };
    let fd: number | undefined;
    try {
      fd = openSync(held.path, constants.O_RDONLY | NOFOLLOW);
      const st = fstatSync(fd);
      if (!st.isFile() || st.dev !== held.dev || st.ino !== held.ino || st.size !== held.size || st.mtimeMs !== held.mtime || !mine(st)) { this.#held.delete(id); return { error: "That file changed, so it is not shown." }; }
      if (offset >= held.size) return { ref: held.ref, offset: held.size, data: Buffer.alloc(0), done: true };
      const want = Math.min(Math.max(1, length), SHELF.chunk, held.size - offset);
      const data = Buffer.alloc(want);
      const got = readSync(fd, data, 0, want, offset);
      return { ref: held.ref, offset, data: data.subarray(0, got), done: offset + got >= held.size };
    } catch { this.#held.delete(id); return { error: "That file is not there any more." }; }
    finally { if (fd !== undefined) closeSync(fd); }
  }
}
