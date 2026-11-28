import { spawn } from "@navvied/engine";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { killTree, usesProcessGroups } from "@navvied/engine";
import { ArchiveError, extractArchive } from "./archive.ts";
import { download } from "./download.ts";
import { IMAGE_SETTINGS, MEDIA_SETUPS, type Piece, type Setup, type SystemKey } from "./media-pins.ts";
import type { MediaConfig } from "./media-config.ts";

export type MediaToolId = keyof typeof MEDIA_SETUPS;

/** The kind of computer this is, as the pins name it; nothing for a kind that has no pinned build. */
export const systemKey = (platform: NodeJS.Platform, arch: string): SystemKey | undefined => (platform === "linux" && arch === "x64" ? "linux-x64" : undefined);

export const setupFor = (id: MediaToolId, platform: NodeJS.Platform, arch: string): Setup | undefined => {
  const key = systemKey(platform, arch);
  return key ? (MEDIA_SETUPS[id] as Partial<Record<SystemKey, Setup>>)[key] : undefined;
};

/** A tool's own folder: its files, the programs taken out of their archives, and the record of what is in it. */
export const toolFolder = (local: string, id: string): string => join(local, "media", id);

/** The folder an archive is taken apart into. */
export const stemOf = (file: string): string => file.replace(/\.(tar\.gz|zip)$/, "");

export type FetchState =
  | { state: "downloading" | "verifying" | "installing"; file: string; bytes: number; total: number }
  | { state: "done" }
  | { state: "failed"; error: string }
  | { state: "idle" };

interface Record_ { files: Record<string, string> }
const recordPath = (dir: string): string => join(dir, "installed.json");
const readRecord = (dir: string): Record_ => { try { return JSON.parse(readFileSync(recordPath(dir), "utf8")) as Record_; } catch { return { files: {} }; } };

const here = (dir: string, p: Piece): string => (p.unpack ? join(dir, stemOf(p.file)) : join(dir, p.file));

/** Whether every piece was fetched, proven and put in place by an earlier setup, and is still there. */
export function isFetched(dir: string, pieces: readonly Piece[]): boolean {
  const rec = readRecord(dir);
  return pieces.every((p) => rec.files[p.file] === p.sha256 && existsSync(here(dir, p)));
}

/** Runs a program once, without a shell and without the keys of this program in its environment; true when it ends well in time. */
export function tryProgram(argv: readonly string[], ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const [bin, ...args] = argv;
    const child = spawn(bin!, args, { cwd: dirname(bin!), stdio: "ignore", windowsHide: true, detached: usesProcessGroups() });
    const clock = setTimeout(() => { killTree(child); }, ms);
    child.on("error", () => { clearTimeout(clock); resolve(false); });
    child.on("close", (code) => { clearTimeout(clock); resolve(code === 0); });
  });
}

export interface FetchInput {
  pieces: readonly Piece[];
  dir: string;
  fetchFn: typeof fetch;
  freeBytes: () => number | undefined;
  signal?: AbortSignal;
  onState: (s: FetchState) => void;
  /** Tries the program once after everything is in place (a test gives its own). */
  tryProgram?: (argv: readonly string[]) => Promise<boolean>;
  /** The program and its arguments, when there is one to try. */
  check?: { program: string; args: readonly string[] };
}

/**
 * Fetches each file, proves it is the one that was published (a file with another hash is deleted and nothing of it is run), takes archives apart with this program's own reader
 * into a folder that is made owner-only, and writes down what is in place. Taken up again where it stopped: a file already proven is not fetched twice, and a part is asked past
 * the bytes it has. Stopping (`pause`, `cancel`) leaves the parts for a later start.
 */
export async function fetchPieces(i: FetchInput): Promise<{ ok: true } | { ok: false; error: string; stopped?: true }> {
  const fail = (error: string): { ok: false; error: string } => { i.onState({ state: "failed", error }); return { ok: false, error }; };
  mkdirSync(i.dir, { recursive: true, mode: 0o700 });
  mkdirSync(join(i.dir, "downloads"), { recursive: true, mode: 0o700 });
  const rec = readRecord(i.dir);
  const todo = i.pieces.filter((p) => !(rec.files[p.file] === p.sha256 && existsSync(here(i.dir, p))));
  const total = todo.reduce((n, p) => n + p.size, 0);
  let before = 0;
  for (const p of todo) {
    const dest = p.unpack ? join(i.dir, "downloads", p.file) : join(i.dir, p.file);
    const got = await download(i.fetchFn, {
      url: p.url, dest, sha256: p.sha256, size: p.size,
      ...(i.signal ? { signal: i.signal } : {}),
      freeBytes: () => { const free = i.freeBytes(); return free === undefined ? undefined : free - (p.unpack ? p.size * 3 : 0); },
      onProgress: (bytes) => i.onState({ state: "downloading", file: p.file, bytes: before + bytes, total }),
    });
    if (!got.ok) {
      if (got.why === "wrong") return fail(`${p.file} is not the file that was published (its hash is different): it was deleted and nothing of it was run.`);
      if (got.why === "nodisk") return fail(`There is not enough room on the disk: ${Math.ceil(got.needBytes / 1048576)} MB are needed and ${Math.floor(got.freeBytes / 1048576)} MB are free.`);
      if (got.why === "paused" || got.why === "cancelled") { i.onState({ state: "idle" }); return { ok: false, error: got.why, stopped: true }; }
      return fail("message" in got ? got.message : "The download did not finish.");
    }
    before += p.size;
    chmodSync(dest, 0o600);
    if (p.unpack) {
      i.onState({ state: "installing", file: p.file, bytes: before, total });
      const stem = here(i.dir, p), staging = `${stem}.unpacking`;
      rmSync(staging, { recursive: true, force: true });
      rmSync(stem, { recursive: true, force: true });
      try { await extractArchive(dest, staging, p.unpack); } catch (e) {
        rmSync(staging, { recursive: true, force: true });
        return fail(e instanceof ArchiveError ? `${p.file} was refused: ${e.message}` : "The downloaded file could not be unpacked.");
      }
      renameSync(staging, stem);
      rmSync(dest, { force: true });
    }
    rec.files[p.file] = p.sha256;
    writeFileSync(recordPath(i.dir), JSON.stringify(rec, null, 2), { mode: 0o600 });
  }
  if (i.check) {
    i.onState({ state: "verifying", file: i.check.program, bytes: total, total });
    if (process.platform !== "win32") chmodSync(i.check.program, 0o700);
    if (!(await (i.tryProgram ?? ((argv) => tryProgram(argv, 20_000)))([i.check.program, ...i.check.args]))) return fail("The program did not start on this computer.");
  }
  i.onState({ state: "done" });
  return { ok: true };
}

/** What the tool reads from `media` in config.json once it is set up. */
export function patchFor(id: MediaToolId, dir: string, setup: Setup): MediaConfig {
  const program = join(dir, setup.program);
  const file = (name: string): string => join(dir, name);
  switch (id) {
    case "speech-to-text": return { stt: { bin: program, model: file("ggml-tiny.en.bin"), language: "en" } };
    case "text-to-speech": return { tts: { engine: "piper", bin: program, model: file("en_US-lessac-low.onnx") } };
    case "image": return { image: { bin: program, model: file("sd_turbo-f16-q8_0.gguf"), ...IMAGE_SETTINGS } };
  }
}
