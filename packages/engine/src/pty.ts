import { bunSpawn, type ChildEnv } from "./process-start.ts";
import { GUARD_STDIO, releaseFds } from "./sandbox/handshake.ts";

/**
 * A real terminal for a program that behaves differently when a person sits at it (a REPL, an installer, a full-screen program). Bun
 * gives a child its own pseudo-terminal on Linux and macOS; where it cannot (Windows, an older Bun) there is none, and the caller falls back.
 */
export interface Pty { pid: number; write(text: string): boolean; kill(signal?: NodeJS.Signals): void }

export const COLS = 100, ROWS = 30;

/** What a program asks its terminal, and what a terminal says back: without the answer a full-screen program waits for ever for the cursor position. */
const QUERIES: [RegExp, (cols: number, rows: number) => string][] = [
  [/\x1b\[6n/g, () => "\x1b[1;1R"],
  [/\x1b\[\?6n/g, () => "\x1b[?1;1R"],
  [/\x1b\[0?c/g, () => "\x1b[?1;2c"],
  [/\x1b\[>0?c/g, () => "\x1b[>0;0;0c"],
  [/\x1b\[5n/g, () => "\x1b[0n"],
  [/\x1b\[18t/g, (cols, rows) => `\x1b[8;${rows};${cols}t`],
];

/** The replies to every terminal question in `output`, in the order they were asked. */
export function answers(output: string, cols = COLS, rows = ROWS): string {
  const found: { at: number; reply: string }[] = [];
  for (const [re, reply] of QUERIES) for (const m of output.matchAll(re)) found.push({ at: m.index, reply: reply(cols, rows) });
  return found.sort((a, b) => a.at - b.at).map((f) => f.reply).join("");
}

export function spawnPty(argv: string[], o: { cwd: string; env: ChildEnv; onData: (text: string) => void; onExit: (code: number | null) => void; /** Confined with a guard that waits to be released (`Launch.guarded`). */ guarded?: boolean }): Pty | undefined {
  if (process.platform === "win32" || typeof Bun === "undefined") return undefined;
  const decoder = new TextDecoder();
  try {
    const child = bunSpawn(argv, {
      cwd: o.cwd,
      env: o.env,
      // The terminal is the command's standard input and output; the two descriptors after them are the guard's.
      ...(o.guarded ? { stdio: [undefined, undefined, undefined, ...GUARD_STDIO] as never } : {}),
      terminal: {
        cols: COLS,
        rows: ROWS,
        data: (terminal, data) => {
          const text = decoder.decode(data, { stream: true });
          const reply = answers(text);
          if (reply) terminal.write(reply);
          o.onData(text);
        },
      },
    });
    if (o.guarded) releaseFds((child as unknown as { stdio: [unknown, unknown, unknown, unknown, number, number] }).stdio.slice(4) as [number, number]);
    void child.exited.then((code) => o.onExit(code));
    return {
      pid: child.pid,
      write: (text) => { try { child.terminal?.write(text); return true; } catch { return false; } },
      kill: (signal = "SIGKILL") => { try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch { /* already gone */ } } },
    };
  } catch { return undefined; }
}
