import { spawn, type ChildProcess } from "node:child_process";
import { homedir } from "node:os";
import { killTree, usesProcessGroups } from "@navvied/engine";
import { delimiter, join } from "node:path";

export interface RunOptions {
  signal?: AbortSignal;
  /** Called with each line the program prints, as it prints it. */
  onLine?: (line: string) => void;
  /** Gives the caller a way to type a line into the program while it runs. Without it the program gets no input. */
  input?: (write: (line: string) => void) => void;
  timeoutMs?: number;
}

/** The parts of the computer the setup screens use: clipboard, browser, programs. Injected, so tests touch none of it. */
export interface System {
  /** What is on the clipboard now, or undefined when it is empty or cannot be read. */
  clipboard(): Promise<string | undefined>;
  /** Open an address in the person's browser. */
  open(url: string): void;
  /** Put a text on the clipboard. False when this computer has no way to (no program for it). */
  copy(text: string): Promise<boolean>;
  /** Where a program is installed, also looking in the places installers put it. */
  which(command: string): string | undefined;
  run(argv: string[], options?: RunOptions): Promise<{ code: number; output: string }>;
}

const CLIPBOARD_READERS: Record<string, string[][]> = {
  darwin: [["pbpaste"]],
  win32: [["powershell", "-NoProfile", "-Command", "Get-Clipboard"]],
  linux: [["wl-paste", "-n"], ["xclip", "-selection", "clipboard", "-o"], ["xsel", "-b", "-o"]],
};

const CLIPBOARD_WRITERS: Record<string, string[][]> = {
  darwin: [["pbcopy"]],
  win32: [["clip"]],
  linux: [["wl-copy"], ["xclip", "-selection", "clipboard"], ["xsel", "-b", "-i"]],
};

const OPENERS: Record<string, string[]> = {
  darwin: ["open"],
  win32: ["cmd", "/c", "start", ""],
  linux: ["xdg-open"],
};

const MAX_CLIPBOARD = 4096;

const running = new Set<ChildProcess>();
let guarded = false;

/** Programs this one started are stopped with it, so a sign-in that was waiting does not linger. */
function guard(child: ChildProcess): void {
  running.add(child);
  child.once("close", () => { running.delete(child); });
  if (guarded) return;
  guarded = true;
  process.once("exit", () => { for (const c of running) killTree(c); });
}

export function realSystem(env: Record<string, string | undefined>, platform: NodeJS.Platform = process.platform): System {
  const home = env.HOME ?? env.USERPROFILE ?? homedir();
  const path = [env.PATH ?? "", join(home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"].join(delimiter);
  const which = (command: string): string | undefined => Bun.which(command, { PATH: path }) ?? undefined;

  const run: System["run"] = (argv, options = {}) => new Promise((resolve) => {
    let output = "";
    let settled = false;
    const child = spawn(argv[0]!, argv.slice(1), { env: { ...env, PATH: path }, detached: usesProcessGroups(), windowsHide: true, stdio: [options.input ? "pipe" : "ignore", "pipe", "pipe"] });
    options.input?.((line) => { try { child.stdin?.write(`${line}\n`); } catch { /* the program has already ended */ } });
    guard(child);
    const stop = (): void => killTree(child);
    const timer = options.timeoutMs ? setTimeout(stop, options.timeoutMs) : undefined;
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", stop);
      resolve({ code, output });
    };
    if (options.signal?.aborted) stop(); else options.signal?.addEventListener("abort", stop, { once: true });
    for (const stream of [child.stdout, child.stderr]) {
      if (!stream) continue;
      let pending = "";
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => {
        output += chunk;
        pending += chunk;
        const lines = pending.split(/\r?\n|\r/);
        pending = lines.pop() ?? "";
        for (const line of lines) if (line.trim()) options.onLine?.(line);
      });
      stream.on("end", () => { if (pending.trim()) options.onLine?.(pending); });
    }
    child.on("error", () => finish(1));
    child.on("close", (code) => finish(code ?? 1));
  });

  return {
    which,
    run,
    async clipboard() {
      for (const argv of CLIPBOARD_READERS[platform] ?? []) {
        if (!which(argv[0]!)) continue;
        const r = await run([which(argv[0]!)!, ...argv.slice(1)], { timeoutMs: 1500 }).catch(() => undefined);
        if (r && r.code === 0) { const text = r.output.trim(); return text && text.length <= MAX_CLIPBOARD ? text : undefined; }
      }
      return undefined;
    },
    async copy(text) {
      for (const argv of CLIPBOARD_WRITERS[platform] ?? []) {
        const path = which(argv[0]!);
        if (!path) continue;
        try {
          const child = Bun.spawn([path, ...argv.slice(1)], { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
          child.stdin.write(text);
          await child.stdin.end();
          if ((await child.exited) === 0) return true;
        } catch { /* try the next one */ }
      }
      return false;
    },
    open(url) {
      if (!/^https:\/\//.test(url)) return;
      const opener = OPENERS[platform];
      if (!opener || !which(opener[0]!)) return;
      try { Bun.spawn([which(opener[0]!)!, ...opener.slice(1), url], { stdout: "ignore", stderr: "ignore", stdin: "ignore" }).unref(); } catch { /* no browser: the address is shown on screen as well */ }
    },
  };
}

/** The key looks like one from `service`: right start, one line, no spaces. */
export function looksLikeKey(text: string | undefined, prefix: string): text is string {
  return text !== undefined && text.startsWith(prefix) && text.length >= prefix.length + 16 && !/\s/.test(text);
}
