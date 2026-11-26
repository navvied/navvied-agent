import { dirname } from "node:path";
import type { PictureInfo } from "@navvied/protocol";

export interface SavedFile { path: string; size: string }

const SAVED = /^Saved (.+) \(([^()]+)\)(?:, [^.]*)?\.$/m;
const DOWNLOADED = /^Downloaded (.+) \((\d+) bytes\)\.$/m;

const sizeWords = (n: number): string => (n < 1024 ? `${n} B` : n < 1_048_576 ? `${Math.round(n / 1024)} KB` : `${(n / 1_048_576).toFixed(1)} MB`);

export function savedFile(output: string): SavedFile | undefined {
  const made = SAVED.exec(output);
  if (made) return { path: made[1]!, size: made[2]! };
  const got = DOWNLOADED.exec(output);
  return got ? { path: got[1]!, size: sizeWords(Number(got[2])) } : undefined;
}

export const pictureFile = (p: PictureInfo): SavedFile => ({ path: p.path, size: `${p.width} × ${p.height}, ${sizeWords(p.bytes)}` });

export class SavedFiles {
  readonly #items: SavedFile[] = [];
  add(file: SavedFile): void { if (!this.#items.some((f) => f.path === file.path)) this.#items.push(file); }
  list(): SavedFile[] { return [...this.#items].reverse(); }
}

export const folderOf = (path: string): string => dirname(path);
