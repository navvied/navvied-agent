import { spawn, type ChildEnv, type ChildProcess } from "@navvied/engine";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface ServerInput {
  binary: string;
  /** The model file. */
  model: string;
  /** The file that lets a model read pictures, when it is one that does. */
  mmproj?: string;
  /** The context of the conversation (the size of the cache is made for it). */
  window: number;
  /** How many layers the card takes: 0 for none, a large number for all. */
  layers: number;
  alias: string;
  /** How long loading may take before it is given up, in milliseconds (a large model takes minutes). */
  loadMs?: number;
  platform?: NodeJS.Platform;
  env?: ChildEnv;
  /** Where a note of the process is kept so that one left by a crash can be found. */
  pidFile: string;
}

export interface RunningServer { pid: number; port: number; url: string; stop(): Promise<void>; exited: Promise<void> }

/** The one line the program prints when it listens (its own wording, read from a real run of the pinned release): `srv  server_on_li: listening on http://127.0.0.1:18765`. */
const LISTENING = /listening on http:\/\/127\.0\.0\.1:(\d+)/;

/** The arguments of the pinned release's server (each is in its own `--help`; the notes have the lines). It listens on this computer only. */
export function argsOf(i: Pick<ServerInput, "model" | "window" | "layers" | "alias" | "mmproj">, port: number): string[] {
  // With no layers on a card, the picture reader stays on the processor too.
  return ["-m", i.model, "-c", String(i.window), "-ngl", String(i.layers), "--host", "127.0.0.1", "--port", String(port), "--jinja", "-a", i.alias, "-np", "1", ...(i.mmproj ? ["--mmproj", i.mmproj, ...(i.layers === 0 ? ["--no-mmproj-offload"] : [])] : [])];
}

interface Note { pid: number; binary: string; port: number; startedAt: number }

export const readNote = (pidFile: string): Note | undefined => { try { return JSON.parse(readFileSync(pidFile, "utf8")) as Note; } catch { return undefined; } };
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; } };

/**
 * Starts the server as a plain child of this program (not detached: whatever ends this program's tree ends it), waits for the line that says it listens, and writes a note of
 * its process. Anything that goes wrong before that says the last thing the program said.
 */
export async function startServer(i: ServerInput): Promise<RunningServer | { error: string }> {
  // Port 0: the server binds a port itself and says which one on its listening line, so none is asked for first and handed over after something else could have taken it.
  const port = 0;
  const child: ChildProcess = spawn(i.binary, argsOf(i, port), { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, ...(i.env ? { env: i.env } : {}) });
  const failedToStart = new Promise<void>((resolve) => { child.once("error", () => resolve()); });
  if (!child.pid) { await failedToStart; return { error: "The program could not be started." }; }
  const tail: string[] = [];
  let ready: ((p: number) => void) | undefined;
  const listening = new Promise<number>((r) => { ready = r; });
  const lines = (chunk: Buffer, buf: { s: string }): void => {
    buf.s += chunk.toString("utf8");
    let at: number;
    while ((at = buf.s.indexOf("\n")) >= 0) {
      const line = buf.s.slice(0, at).replace(/\r$/, "");
      buf.s = buf.s.slice(at + 1);
      if (line.trim()) { tail.push(line); if (tail.length > 40) tail.shift(); }
      const m = LISTENING.exec(line);
      if (m) ready?.(Number(m[1]));
    }
  };
  const out = { s: "" }, err = { s: "" };
  child.stdout!.on("data", (c: Buffer) => lines(c, out));
  child.stderr!.on("data", (c: Buffer) => lines(c, err));
  const exited = new Promise<void>((resolve) => { child.once("exit", () => { rmSync(i.pidFile, { force: true }); resolve(); }); });
  mkdirSync(dirname(i.pidFile), { recursive: true });
  const startedAt = Date.now();
  writeFileSync(i.pidFile, JSON.stringify({ pid: child.pid, binary: i.binary, port, startedAt } satisfies Note));

  // Whatever ends this program ends the server with it: its normal end, a polite signal when nothing else handles it. (A kill that cannot be caught is found by the note, at the next start.)
  const killNow = (): void => { try { child.kill("SIGKILL"); } catch { /* gone */ } };
  const signals = (["SIGTERM", "SIGINT", "SIGHUP"] as const).filter((sig) => process.listenerCount(sig) === 0);
  const onSignal = (sig: NodeJS.Signals): void => { killNow(); process.exit(128 + (sig === "SIGINT" ? 2 : sig === "SIGHUP" ? 1 : 15)); };
  const handlers = signals.map((sig) => { const h = (): void => onSignal(sig); process.once(sig, h); return [sig, h] as const; });
  process.once("exit", killNow);
  void exited.then(() => { process.off("exit", killNow); for (const [sig, h] of handlers) process.off(sig, h); });

  const stop = async (): Promise<void> => {
    if (child.exitCode === null && !child.killed) child.kill("SIGTERM");
    const gone = await Promise.race([exited.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 5000))]);
    if (!gone) { child.kill("SIGKILL"); await exited; }
    rmSync(i.pidFile, { force: true });
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    listening.then((p) => ({ port: p } as const)),
    exited.then(() => ({ died: true } as const)),
    new Promise<{ late: true }>((r) => { timer = setTimeout(() => r({ late: true }), i.loadMs ?? 600_000); }),
  ]);
  clearTimeout(timer);
  if ("port" in result) writeFileSync(i.pidFile, JSON.stringify({ pid: child.pid, binary: i.binary, port: result.port, startedAt } satisfies Note));
  if ("port" in result) return { pid: child.pid, port: result.port, url: `http://127.0.0.1:${result.port}`, stop, exited };
  await stop();
  const said = tail.filter((l) => /\b(error|failed|cannot|unable|invalid|out of memory|exceeds)\b/i.test(l)).slice(-2).map((l) => l.replace(/^\S+\s+[A-Z]\s+/, "").replace(/\s+/g, " ")).join(" ");
  return { error: "late" in result ? "The model took too long to load." : `The model did not start${said ? `: ${said}` : "."}` };
}

/**
 * A server that a program that crashed left behind: found by the note of its process, stopped only if it is the program that was started (its path is asked of the system),
 * and the note taken away either way.
 */
export async function reapOrphan(pidFile: string, run: (argv: string[]) => Promise<{ code: number; output: string }>, platform: NodeJS.Platform = process.platform): Promise<"none" | "stopped" | "not-ours"> {
  const note = readNote(pidFile);
  if (!note) return "none";
  rmSync(pidFile, { force: true });
  if (!alive(note.pid)) return "none";
  const asked = platform === "win32"
    ? await run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${note.pid}").ExecutablePath`])
    : await run(["ps", "-p", String(note.pid), "-o", "args="]);
  const said = asked.output.trim();
  if (asked.code !== 0 || !said || !(platform === "win32" ? said.toLowerCase() === note.binary.toLowerCase() : said.startsWith(note.binary))) return "not-ours";
  try { process.kill(note.pid, "SIGTERM"); } catch { return "none"; }
  for (let n = 0; n < 30 && alive(note.pid); n++) await new Promise((r) => setTimeout(r, 100));
  if (alive(note.pid)) { try { process.kill(note.pid, "SIGKILL"); } catch { /* gone */ } }
  return "stopped";
}

