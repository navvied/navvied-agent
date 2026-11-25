import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { McpClient, NotSent, type Tool, type Wire } from "./mcp.ts";
import type { Pin } from "./pin.ts";

/** A child program as the host sees it. The real one is made from `Bun.spawn`; tests make their own. */
export interface Child {
  write(data: string): void;
  /** Lines of standard output. */
  onLine(fn: (line: string) => void): void;
  onExit(fn: (code: number | null) => void): void;
  /** Closes the child's standard input: the daemon shuts down itself when it sees the end. */
  closeInput(): void;
  kill(): void;
}
export type Spawn = (cmd: string, args: string[], env: Record<string, string>) => Child;
export type Probe = (cmd: string, args: string[], env: Record<string, string>) => Promise<boolean>;

/** What a driver may see of this program's environment: where programs are and who the person is, never a key or a token. */
const KEEP = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR", "TEMP", "TMP", "DISPLAY", "XAUTHORITY", "SYSTEMROOT", "WINDIR", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "COMSPEC", "PATHEXT"];

export function driverEnv(base: Record<string, string | undefined>, pin: Pin): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of KEEP) { const v = base[k]; if (v !== undefined) env[k] = v; }
  // Embedded: the person's grants belong to the program that started the driver. Standard: the host's own approvals are the ones that count; the driver never runs without them.
  return { ...env, CUA_DRIVER_EMBEDDED: "1", CUA_DRIVER_PERMISSION_MODE: "standard", CUA_DRIVER_HOST_BUNDLE_ID: pin.bundleId };
}

/** A private place for the driver's socket: a folder only this person can enter, or a pipe name on Windows. */
export function socketPath(platform: string, stateDir: string, pid: number): string {
  if (platform === "win32") return `\\\\.\\pipe\\navvied-cua-${pid}`;
  const dir = mkdtempSync(join((mkdirSync(stateDir, { recursive: true, mode: 0o700 }), stateDir), "sock-"));
  return join(dir, "driver.sock");
}

export function missingFrom(pin: Pin, tools: Tool[]): string[] {
  const out: string[] = [];
  for (const [name, props] of Object.entries(pin.needs)) {
    const t = tools.find((x) => x.name === name);
    if (!t) { out.push(name); continue; }
    for (const p of props) if (!(p in (t.inputSchema?.properties ?? {}))) out.push(`${name}.${p}`);
  }
  return out;
}

export type Started = { ok: true; client: McpClient } | { ok: false; why: "not-ready" | "mismatch"; message: string };

export interface HostInput {
  entry: string;
  pin: Pin;
  platform: string;
  env: Record<string, string | undefined>;
  stateDir: string;
  pid: number;
  spawn: Spawn;
  /** Runs `<entry> status --socket <path>` and says whether the daemon answered. */
  probe: Probe;
  /** How long the daemon gets to answer before the start is given up, and the pause between asks. */
  readyMs?: number;
  stepMs?: number;
  onStopped?: (unexpected: boolean) => void;
}

/**
 * Runs the driver as two children of this program and nothing else: the daemon, which holds the person's grants and does the work, and the proxy that speaks the tool protocol on its
 * standard streams. Starts that overlap are one start; a stop is safe to repeat and cancels a start in progress; a driver that dies by itself is reported once and never started again by the host.
 */
export class DriverHost {
  private starting?: Promise<Started>;
  private daemon?: Child;
  private proxy?: Child;
  private client?: McpClient;
  private stopping = false;
  private generation = 0;
  private gone: Promise<void> = Promise.resolve();
  private last?: Child;

  constructor(private i: HostInput) {}

  start(): Promise<Started> { return (this.starting ??= this.boot().finally(() => { if (!this.client) this.starting = undefined; })); }

  private async boot(): Promise<Started> {
    const gen = ++this.generation;
    this.stopping = false;
    const { i } = this;
    const env = driverEnv(i.env, i.pin);
    const path = socketPath(i.platform, i.stateDir, i.pid);
    const daemon = this.daemon = this.last = i.spawn(i.entry, ["serve", "--embedded", "--socket", path, "--parent-liveness-stdio"], env);
    let exited!: () => void;
    this.gone = new Promise<void>((r) => { exited = r; });
    daemon.onExit(() => { exited(); if (gen === this.generation && !this.stopping) { this.stopping = true; i.onStopped?.(true); this.drop(); } });

    const until = Date.now() + (i.readyMs ?? 10_000);
    let ready = false;
    while (!this.stopping && Date.now() < until) {
      if (await i.probe(i.entry, ["status", "--socket", path], env)) { ready = true; break; }
      await new Promise((r) => setTimeout(r, i.stepMs ?? 100));
    }
    if (!ready || this.stopping) { this.drop(); return { ok: false, why: "not-ready", message: "The driver did not start." }; }

    const proxy = this.proxy = i.spawn(i.entry, ["mcp", "--embedded", "--socket", path], env);
    const lines: ((l: string) => void)[] = [], closes: (() => void)[] = [];
    proxy.onLine((l) => lines.forEach((f) => f(l)));
    proxy.onExit(() => closes.forEach((f) => f()));
    const wire: Wire = { write: (l) => proxy.write(l + "\n"), onLine: (f) => lines.push(f), onClose: (f) => closes.push(f) };
    const client = new McpClient(wire);
    try {
      await client.initialize();
      const missing = missingFrom(i.pin, await client.tools());
      if (missing.length) { this.drop(); return { ok: false, why: "mismatch", message: `This driver is not the one navvied expects (missing ${missing.join(", ")}).` }; }
    } catch {
      this.drop();
      return { ok: false, why: "not-ready", message: "The driver did not answer." };
    }
    this.client = client;
    return { ok: true, client };
  }

  private drop(): void {
    this.client = undefined; this.starting = undefined;
    this.proxy?.kill(); this.proxy = undefined;
    this.daemon?.closeInput(); const d = this.daemon; this.daemon = undefined;
    // The daemon ends itself when its input ends; the kill is for one that does not.
    if (d) setTimeout(() => d.kill(), 3000).unref?.();
  }

  stop(): void {
    if (this.stopping && !this.daemon) return;
    this.stopping = true;
    this.drop();
    this.i.onStopped?.(false);
  }

  /** Stops, then waits for the daemon to be gone (it ends when its input does) and ends it by force if it is not gone in time: for a program that is about to exit and would leave it behind. */
  async close(graceMs = 3000): Promise<void> {
    const gone = this.gone, daemon = this.last;
    this.stop();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<"late">((r) => { timer = setTimeout(() => r("late"), graceMs); });
    const result = await Promise.race([gone.then(() => "gone" as const), late]);
    clearTimeout(timer);
    if (result === "late") daemon?.kill();
  }

  get running(): McpClient | undefined { return this.client; }

  call(...a: Parameters<McpClient["call"]>) {
    if (!this.client) return Promise.reject(new NotSent("The driver is not running."));
    return this.client.call(...a);
  }
}
