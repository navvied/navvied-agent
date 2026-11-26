import { spawn, type ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import { killTree, usesProcessGroups } from "../platform.ts";

const RUNNER = `import sys, os, json, traceback
sys.stdin.reconfigure(encoding="utf-8", newline="\\n")
sys.stdout.reconfigure(encoding="utf-8", newline="\\n")
sys.path.insert(0, os.environ["NAVVIED_CODE_DIR"])
sys.stderr = sys.stdout
g = {"__name__": "__main__"}
import navvied_tools
for line in sys.stdin:
    req = json.loads(line)
    navvied_tools._reset((req["port"], req["token"]))
    status = 0
    try:
        exec(compile(req["code"], "<script>", "exec"), g)
    except SystemExit as e:
        status = e.code if isinstance(e.code, int) else (0 if e.code is None else 1)
    except BaseException:
        kind, value, tb = sys.exc_info()
        traceback.print_exception(kind, value, tb.tb_next if tb and tb.tb_next else tb)
        status = 1
    sys.stdout.flush()
    sys.stdout.write("\\n\\x01navvied-done:%d\\x01\\n" % status)
    sys.stdout.flush()
`;
export { RUNNER };

const DONE = /\n\x01navvied-done:(-?\d+)\x01\n/;
const MARK = "\n\x01navvied-done:";

/** How much of what was read can be handed on: not the end of it that may be the beginning of the line that ends a script. */
function sendable(held: string): number {
  const at = held.lastIndexOf("\n\x01");
  if (at >= 0) return at;
  for (let k = Math.min(held.length, MARK.length - 1); k > 0; k--) if (MARK.startsWith(held.slice(-k))) return held.length - k;
  return held.length;
}

export interface Ran { text: string; exit: number | null; timedOut: boolean; interrupted: boolean; /** The variables of the conversation were lost: the program had to be started again, or was stopped. */ lost: boolean }

/** One Python program for a conversation. It is started by the first script and stopped when the conversation ends, or when a script has to be stopped. */
export class CodeSession {
  #child: ChildProcess | undefined;
  #held = "";
  #starts = 0;
  constructor(private readonly o: { python: string; dir: string; cwd: string; env: Record<string, string> }) {}
  get dir(): string { return this.o.dir; }

  #start(): ChildProcess {
    const child = spawn(this.o.python, ["-u", "-c", RUNNER], { cwd: this.o.cwd, env: { ...this.o.env, NAVVIED_CODE_DIR: this.o.dir, PYTHONDONTWRITEBYTECODE: "1", PYTHONUTF8: "1" }, detached: usesProcessGroups(), windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    child.stdin!.on("error", () => undefined);
    child.stderr!.on("data", () => undefined);
    child.once("close", () => { if (this.#child === child) this.#child = undefined; });
    this.#child = child;
    this.#starts += 1;
    return child;
  }

  run(code: string, o: { port: number; token: string; reset?: boolean; timeoutMs: number; signal: AbortSignal; onOut(text: string): void }): Promise<Ran> {
    if (o.reset) { this.#kill(); this.#starts = 0; }
    const had = this.#child !== undefined;
    const child = this.#child ?? this.#start();
    const lost = !had && this.#starts > 1;
    this.#held = "";
    return new Promise<Ran>((done) => {
      let timedOut = false, interrupted = false, settled = false;
      const finish = (r: Omit<Ran, "lost">): void => { if (settled) return; settled = true; clearTimeout(timer); o.signal.removeEventListener("abort", onAbort); child.stdout!.off("data", onData); child.off("close", onClose); done({ ...r, lost: lost || timedOut || interrupted }); };
      const stop = (): void => { killTree(child); this.#child = undefined; };
      const timer = setTimeout(() => { timedOut = true; stop(); }, o.timeoutMs);
      const onAbort = (): void => { interrupted = true; stop(); };
      let text = "";
      const onData = (d: Buffer): void => {
        this.#held += d.toString("utf8");
        const m = DONE.exec(this.#held);
        if (m) {
          const before = this.#held.slice(0, m.index);
          if (before) { text += before; o.onOut(before); }
          this.#held = "";
          finish({ text, exit: Number(m[1]), timedOut, interrupted });
          return;
        }
        // Keep back only what could be the start of the line that ends the script; the rest is sent on at once.
        const send = this.#held.slice(0, sendable(this.#held));
        if (send) { text += send; o.onOut(send); this.#held = this.#held.slice(send.length); }
      };
      const onClose = (): void => { if (this.#held) { text += this.#held; o.onOut(this.#held); this.#held = ""; } finish({ text, exit: null, timedOut, interrupted }); };
      o.signal.addEventListener("abort", onAbort, { once: true });
      child.stdout!.on("data", onData);
      child.once("close", onClose);
      if (o.signal.aborted) { onAbort(); return; }
      child.stdin!.write(`${JSON.stringify({ code, port: o.port, token: o.token })}\n`);
    });
  }

  /** Stops the program and removes the folder; to start afresh without ending the conversation, send `reset`. */
  #kill(): void {
    const child = this.#child;
    this.#child = undefined;
    if (child) killTree(child);
  }

  close(): void {
    this.#kill();
    try { rmSync(this.o.dir, { recursive: true, force: true }); } catch { /* a leftover temp folder */ }
  }
}
