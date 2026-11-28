import { spawn } from "../process-start.ts";
import { killTree, usesProcessGroups } from "../platform.ts";
import { MediaError } from "./types.ts";

export interface Ran { code: number; out: Buffer; err: string }

const name = (bin: string): string => bin.split(/[\\/]/).pop()!.replace(/\.exe$/i, "") || "The program";

/**
 * Runs a program without a shell, in `cwd`, with this program's environment minus the keys it uses itself. Text for it goes to standard input, never into the argument list.
 * A program that does not finish in `ms` or is cancelled is stopped, and that is said in words.
 */
export function run(argv: readonly string[], o: { cwd: string; ms: number; signal: AbortSignal; stdin?: string }): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const [bin, ...args] = argv;
    const child = spawn(bin!, args, { cwd: o.cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, detached: usesProcessGroups() });
    const out: Buffer[] = [], err: Buffer[] = [];
    let bytes = 0, why = "";
    const stop = (reason: string): void => { why ||= reason; killTree(child); };
    const clock = setTimeout(() => stop(`${name(bin!)} did not finish in ${Math.round(o.ms / 1000)} seconds.`), o.ms);
    const abort = (): void => stop("It was stopped.");
    if (o.signal.aborted) abort(); else o.signal.addEventListener("abort", abort, { once: true });
    const done = (): void => { clearTimeout(clock); o.signal.removeEventListener("abort", abort); };
    child.stdout.on("data", (d: Buffer) => { bytes += d.length; if (bytes > 50_000_000) stop(`${name(bin!)} printed too much.`); else out.push(d); });
    child.stderr.on("data", (d: Buffer) => { if (err.length < 64) err.push(d); });
    child.on("error", (e) => { done(); reject(new MediaError(`${name(bin!)} could not be started: ${(e as NodeJS.ErrnoException).code ?? e.message}.`)); });
    child.on("close", (code) => {
      done();
      if (why) reject(new MediaError(why));
      else resolve({ code: code ?? 1, out: Buffer.concat(out), err: Buffer.concat(err).toString("utf8").trim() });
    });
    child.stdin.on("error", () => { /* the program ended before it read its input: its exit code says why */ });
    child.stdin.end(o.stdin ?? "");
  });
}

/** The last line a program printed to its error output, short, for a sentence about why it failed. */
export const lastLine = (err: string): string => { const l = err.split("\n").map((x) => x.trim()).filter(Boolean).at(-1) ?? ""; return l.length > 160 ? `${l.slice(0, 159)}…` : l; };

