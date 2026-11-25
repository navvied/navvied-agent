import type { ComputerResult } from "@navvied/engine";
import type { PermMode } from "@navvied/protocol";
import { DriverAdapter, type Readiness } from "./adapter.ts";
import { Guard } from "./guard.ts";
import { DriverHost, type Probe, type Spawn } from "./host.ts";
import { entryOf, install as realInstall, type Installed, type Run } from "./install.ts";
import type { CallResult } from "./mcp.ts";
import { existsSync } from "node:fs";
import { PIN, supportOf, type Pin, type Support } from "./pin.ts";

export interface ServiceInput {
  platform: string;
  arch: string;
  env: Record<string, string | undefined>;
  /** Where the driver is kept, and where its sockets are made. */
  dir: string;
  fetchFn: typeof fetch;
  run: Run;
  spawn: Spawn;
  probe: Probe;
  pid: number;
  /** The names navvied's own windows go by, which are never acted on. */
  ownApps: readonly string[];
  /** Whether the person is using the screen themselves right now. */
  humanHasControl?: () => boolean;
  /** Which app the agent is using while a step runs, `undefined` when it lets go (for the indicator with Stop). */
  indicator?: (app: string | undefined) => void;
  trace?: ConstructorParameters<typeof DriverAdapter>[0]["trace"];
  pin?: Pin;
  install?: typeof realInstall;
}

const refusal = (next: string, code: NonNullable<ComputerResult["code"]> = "background_unavailable"): Readiness => ({ ok: false, refusal: { verdict: "refused", code, next } });

/**
 * The screen of this computer for every conversation of one program: one driver, started the first time a conversation uses the screen, and one
 * helper for each conversation (its own approvals, its own target, its own limits). The driver is never started again once it has stopped by
 * itself: the person is told, and turns computer use off and on.
 */
export class ComputerUse {
  private host?: DriverHost;
  private starting?: Promise<Readiness>;
  private failed?: Readiness;
  private helpers = new Set<DriverAdapter>();

  constructor(private i: ServiceInput) {}

  private ready = async (): Promise<Readiness> => {
    if (this.failed) return this.failed;
    if (this.host?.running) return { ok: true };
    const start = (this.starting ??= this.start().finally(() => { this.starting = undefined; }));
    return start;
  };

  private async start(): Promise<Readiness> {
    const i = this.i, pin = i.pin ?? PIN;
    const support = supportOf(i.platform, i.arch, i.env);
    if (!support.ok) return refusal(support.message);
    const got = await (i.install ?? realInstall)({ fetchFn: i.fetchFn, run: i.run, dir: i.dir, pin, target: support.target, platform: i.platform });
    if (!got.ok) return refusal(got.why === "download" ? "The screen helper could not be downloaded. Tell the person and stop." : "The screen helper could not be checked and is not used. Tell the person and stop.");
    const host = new DriverHost({
      entry: got.entry, pin, platform: i.platform, env: i.env, stateDir: i.dir + "/run", pid: i.pid, spawn: i.spawn, probe: i.probe,
      onStopped: (unexpected) => { if (unexpected) this.failed = refusal("The screen helper stopped. Ask the person to turn computer use off and on."); },
    });
    this.host = host;
    const started = await host.start();
    return started.ok ? { ok: true } : refusal(started.why === "mismatch" ? "The screen helper is not the one navvied expects. Tell the person and stop." : "The screen helper did not start. Tell the person and stop.");
  }

  /** Whether this computer can be driven, and as what. */
  support(): Support { return supportOf(this.i.platform, this.i.arch, this.i.env); }

  /** Whether the driver is already on this computer (it is checked again before it is started). */
  installed(): boolean { const s = this.support(); return s.ok && existsSync(entryOf(this.i.dir, this.i.pin ?? PIN, s.target)); }

  /** Fetches the driver and checks it, telling how far it is. */
  async fetch(onProgress: (bytes: number, total: number) => void, signal?: AbortSignal): Promise<Installed | { ok: false; why: "unsupported"; message: string }> {
    const s = this.support();
    if (!s.ok) return { ok: false, why: "unsupported", message: s.message };
    return (this.i.install ?? realInstall)({ fetchFn: this.i.fetchFn, run: this.i.run, dir: this.i.dir, pin: this.i.pin ?? PIN, target: s.target, platform: this.i.platform, onProgress, ...(signal ? { signal } : {}) });
  }

  /** The helper of one conversation; each call tells it the conversation's mode, so a person who changes it is obeyed at once. */
  helper(): DriverAdapter {
    const mode: { current: PermMode } = { current: "ask" };
    const guard = new Guard({ mode: () => mode.current, ownApps: this.i.ownApps, humanHasControl: () => this.i.humanHasControl?.() ?? false });
    const a = new DriverAdapter({
      guard, mode, platform: this.i.platform, ready: this.ready,
      ...(this.i.indicator ? { indicator: this.i.indicator } : {}),
      ...(this.i.trace ? { trace: this.i.trace } : {}),
      driver: { call: (name, args, ms) => (this.host ? this.host.call(name, args, ms) : Promise.reject(new Error("not started"))) as Promise<CallResult> },
    });
    this.helpers.add(a);
    return a;
  }

  /** The person's Stop, for every conversation at once. */
  halt(): void { for (const h of this.helpers) h.halt(); }
  resume(): void { for (const h of this.helpers) h.resume(); }

  /** Computer use turned off: the approvals of every conversation are forgotten, and the driver is stopped. */
  async close(): Promise<void> { for (const h of this.helpers) h.forget(); await this.host?.close(); this.host = undefined; this.failed = undefined; this.helpers.clear(); }
}
