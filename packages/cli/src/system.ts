import { ChildEnv, bunSpawn, spawn, type ChildProcess } from "@navvied/engine";
import { homedir } from "node:os";
import { killTree, launch, usesProcessGroups } from "@navvied/engine";
import { delimiter, join } from "node:path";

export interface RunOptions {
  signal?: AbortSignal;
  /** Called with each line the program prints, as it prints it. */
  onLine?: (line: string) => void;
  /** Gives the caller a way to type a line into the program while it runs. Without it the program gets no input. */
  input?: (write: (line: string) => void) => void;
  timeoutMs?: number;
  keep?: readonly string[];
  env?: Readonly<Record<string, string>>;
}

/** The parts of the computer the setup screens use: the clipboard to write to, the browser, programs. Injected, so tests touch none of it. */
export interface System {
  /** Open an address in the person's browser. */
  open(url: string): void;
  /** Put a text on the clipboard. False when this computer has no way to (no program for it). */
  copy(text: string): Promise<boolean>;
  /** Where a program is installed, also looking in the places installers put it. */
  which(command: string): string | undefined;
  run(argv: string[], options?: RunOptions): Promise<{ code: number; output: string }>;
}

const CLIPBOARD_WRITERS: Record<string, string[][]> = {
  darwin: [["pbcopy"]],
  win32: [["clip"]],
  linux: [["wl-copy"], ["xclip", "-selection", "clipboard"], ["xsel", "-b", "-i"]],
};

const OPENERS: Record<string, string[]> = {
  darwin: ["open"],
  // Not `cmd /c start`: cmd reads the & of an address as the end of the command, so `#connect=…&key=…` lost its key.
  win32: ["rundll32", "url.dll,FileProtocolHandler"],
  linux: ["xdg-open"],
};

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
    const [program, ...args] = launch(argv);
    const child = spawn(program!, args, { env: ChildEnv.scrubbed(env, options.keep ? { keep: options.keep } : {}).with({ ...options.env, PATH: path }), detached: usesProcessGroups(), windowsHide: true, stdio: [options.input ? "pipe" : "ignore", "pipe", "pipe"] });
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
    async copy(text) {
      for (const argv of CLIPBOARD_WRITERS[platform] ?? []) {
        const path = which(argv[0]!);
        if (!path) continue;
        try {
          const child = bunSpawn([path, ...argv.slice(1)], { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
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
      try { bunSpawn([which(opener[0]!)!, ...opener.slice(1), url], { stdout: "ignore", stderr: "ignore", stdin: "ignore" }).unref(); } catch { /* no browser: the address is shown on screen as well */ }
    },
  };
}
